// Message shapes between the page tap (MAIN world), the content script (ISOLATED world), the
// service worker, the panel and the export page.

/** window.postMessage channel tag used by the page tap. */
export const FEED_CHANNEL = 'quorum-feed-v1';
/** chrome.runtime.connect port name used by the content script. */
export const FEED_PORT = 'feed';

export interface TapFrame {
  /** Socket number within the page (frame), assigned by the tap. */
  sid: number;
  url: string;
  dir: 'in' | 'out';
  enc: 'text' | 'base64';
  data: string;
  /** Local time the tap saw the frame (Date.now()). */
  t: number;
}

export interface TapBatch {
  channel: typeof FEED_CHANNEL;
  type: 'batch';
  frames: TapFrame[];
}

export interface TapStatus {
  channel: typeof FEED_CHANNEL;
  type: 'status';
  sockets: number;
  frames: number;
  /** Errors the tap swallowed (its own, never the page's). */
  errors: number;
  /** Frames dropped by the tap (Blob reads that failed or took too long, queue overflow). */
  dropped: number;
}

export type TapMessage = TapBatch | TapStatus;

const MAX_FRAMES_PER_BATCH = 20_000; // TUNABLE: sanity cap on one 250 ms batch; far above any plausible feed rate
const MAX_FRAME_CHARS = 16 * 1024 * 1024; // TUNABLE: ignore frames over 16 MB (base64) rather than store them

function isTapFrame(f: unknown): f is TapFrame {
  if (typeof f !== 'object' || f === null) return false;
  const x = f as Record<string, unknown>;
  return (
    typeof x.sid === 'number' &&
    typeof x.url === 'string' &&
    (x.dir === 'in' || x.dir === 'out') &&
    (x.enc === 'text' || x.enc === 'base64') &&
    typeof x.data === 'string' &&
    x.data.length <= MAX_FRAME_CHARS &&
    typeof x.t === 'number'
  );
}

/** Validates anything arriving on window 'message' before it is forwarded. */
export function isTapMessage(m: unknown): m is TapMessage {
  if (typeof m !== 'object' || m === null) return false;
  const x = m as Record<string, unknown>;
  if (x.channel !== FEED_CHANNEL) return false;
  if (x.type === 'batch') return Array.isArray(x.frames) && x.frames.length <= MAX_FRAMES_PER_BATCH && x.frames.every(isTapFrame);
  if (x.type === 'status') return ['sockets', 'frames', 'errors', 'dropped'].every((k) => typeof x[k] === 'number');
  return false;
}

/** Content script -> service worker, over the 'feed' port. */
export type PortMessage = { type: 'tap'; msg: TapMessage; origin: string; top: boolean };

// ---- panel / export page <-> service worker (chrome.runtime.sendMessage) ----

export type PanelRequest =
  | { type: 'panel/snapshot' }
  | { type: 'panel/candles'; asset: string; n: number }
  | { type: 'panel/recorder'; on: boolean }
  | { type: 'panel/open-export'; what: 'raw' | 'dataset' };

export interface TabInfo {
  tabId: number;
  socketUrls: string[];
  viewing: string | null;
  assets: string[];
  lastFrameAt: number;
  frames: number;
  tap: { sockets: number; errors: number; dropped: number } | null;
}

export interface AssetRow {
  asset: string;
  isOTC: boolean;
  ticksStored: number;
  candles1m: number;
  /** Local ms since the last tick for this asset was received; null if none this session. */
  lastTickAgeMs: number | null;
  payout: number | null;
  tabs: number[];
}

export interface RecorderView {
  on: boolean;
  startedAt: number | null;
  stoppedReason: 'manual' | 'time' | 'cap' | null;
  framesThisRun: number;
  framesStored: number;
  approxMB: number;
  timeLeftMs: number | null;
  frameCap: number;
}

export interface DecodeView {
  ticks: number;
  duplicateTicks: number;
  staleTicks: number;
  ticksRejected: number;
  candles: number;
  candlesRejected: number;
  candlesSkippedOpen: number;
  payouts: number;
  badPayloads: number;
  orphanBinaries: number;
  unknownFrames: number;
}

export interface PanelSnapshot {
  now: number;
  /** Tab id of the panel that asked, filled in per request by the worker. */
  selfTabId: number | null;
  serverOffsetMs: number | null;
  framesSeen: number;
  tabs: TabInfo[];
  assets: AssetRow[];
  recorder: RecorderView;
  unknownEvents: { name: string; count: number }[];
  decode: DecodeView;
  /** Most recent errors the worker caught, newest last. */
  errors: string[];
}

export interface CandleRow {
  openTs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  source: 'feed' | 'rebuilt';
}

export type PanelResponse<R extends PanelRequest> = R extends { type: 'panel/snapshot' }
  ? PanelSnapshot
  : R extends { type: 'panel/candles' }
    ? CandleRow[]
    : { ok: boolean; error?: string };
