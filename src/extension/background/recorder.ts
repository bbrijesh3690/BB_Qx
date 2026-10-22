// Raw-frame recorder state. On by default; a run stops itself after 1 h or at a frame cap, and the
// panel toggles it. BB_Qx.md asks for 24 h of raw frames to map the schema, but the first 12-minute
// recording (2026-10-22) already mapped it; a recorded day now comes from ticks, which are far smaller.
// Pure functions over a plain object so the worker can persist it in chrome.storage.local.

// TUNABLE: long enough to capture a schema change or a new event; short enough to stay around 30 MB.
export const RECORDER_MAX_MS = 3_600_000;
// TUNABLE: about 1 h of 5 assets at ~25 frames/s each; bounds disk use and export size.
export const RECORDER_FRAME_CAP = 500_000;
// TUNABLE: per-frame bookkeeping (seq, receivedAt, tabId, dir, encoding, keys) on top of data and URL lengths.
const RECORD_OVERHEAD_BYTES = 96;

export interface RecorderState {
  on: boolean;
  startedAt: number | null;
  stoppedReason: 'manual' | 'time' | 'cap' | null;
  framesThisRun: number;
  /** Approximate bytes of every frame stored, across runs. */
  bytesTotal: number;
}

export function initialRecorder(now: number): RecorderState {
  return { on: true, startedAt: now, stoppedReason: null, framesThisRun: 0, bytesTotal: 0 };
}

/** Applies the time and frame limits. Returns the same object when nothing changes. */
export function checkRecorder(s: RecorderState, now: number, cap = RECORDER_FRAME_CAP): RecorderState {
  if (!s.on) return s;
  if (s.startedAt !== null && now - s.startedAt >= RECORDER_MAX_MS) return { ...s, on: false, stoppedReason: 'time' };
  if (s.framesThisRun >= cap) return { ...s, on: false, stoppedReason: 'cap' };
  return s;
}

/** How many more frames this run may store. */
export function allowance(s: RecorderState, cap = RECORDER_FRAME_CAP): number {
  return s.on ? Math.max(0, cap - s.framesThisRun) : 0;
}

export function recordFrames(s: RecorderState, frames: number, bytes: number): RecorderState {
  return { ...s, framesThisRun: s.framesThisRun + frames, bytesTotal: s.bytesTotal + bytes };
}

/** Turning it on starts a fresh run with its own time limit and frame cap. */
export function setRecorder(s: RecorderState, on: boolean, now: number): RecorderState {
  if (on) return { ...s, on: true, startedAt: now, stoppedReason: null, framesThisRun: 0 };
  return s.on ? { ...s, on: false, stoppedReason: 'manual' } : s;
}

export function timeLeftMs(s: RecorderState, now: number): number | null {
  return s.on && s.startedAt !== null ? Math.max(0, s.startedAt + RECORDER_MAX_MS - now) : null;
}

export function frameBytes(f: { data: string; socketUrl: string }): number {
  return f.data.length + f.socketUrl.length + RECORD_OVERHEAD_BYTES;
}

export function isRecorderState(v: unknown): v is RecorderState {
  if (typeof v !== 'object' || v === null) return false;
  const x = v as Record<string, unknown>;
  return typeof x.on === 'boolean' && typeof x.framesThisRun === 'number' && typeof x.bytesTotal === 'number';
}
