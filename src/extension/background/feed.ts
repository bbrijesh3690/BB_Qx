// Everything the service worker does with incoming frames, independent of the chrome.* APIs so it
// can be tested in Node: redact -> record raw -> parse -> assemble -> decode -> dedupe -> sink.

import type { MarketEvent, RawFrameRecord } from '../../core/contracts';
import { QuotexDecoder, type DecoderStats } from '../quotex/decoder';
import { redactFrame, redactUrl } from '../quotex/redact';
import { BinaryAssembler, parseFrame } from '../quotex/socketio';
import type { DecodeView, TabInfo, TapBatch, TapStatus } from '../shared/messages';
import { OffsetEstimator } from './clock';
import { TickGate } from './dedupe';
import { allowance, checkRecorder, frameBytes, recordFrames, type RecorderState } from './recorder';
import type { FeedSink } from './sink';

const FEED_ACTIVE_MS = 10_000; // TUNABLE: a tab with no frame for this long no longer counts as feeding (matches the panel's red dot)
const FEEDING_WINDOW_MS = 60_000; // TUNABLE: a tab is listed as feeding an asset if it delivered one of its ticks this recently
const SOCKET_IDLE_MS = 10 * 60_000; // TUNABLE: forget a socket's parser state after this long without frames
const MAX_ERRORS = 20;

export interface RawFrameStore {
  appendRawFrames(frames: Omit<RawFrameRecord, 'seq'>[]): Promise<void>;
}

export interface FeedDeps {
  frames: RawFrameStore;
  sink: FeedSink;
  getRecorder(): RecorderState;
  setRecorder(s: RecorderState): void;
}

interface TabState {
  tabId: number;
  socketUrls: Set<string>;
  viewing: string | null;
  lastFrameAt: number;
  frames: number;
  tap: Map<number, TapStatus>;
}

interface AssetState {
  lastTickLocal: number;
  /** tabId -> local time of the last tick for this asset seen in that tab. */
  tabs: Map<number, number>;
}

interface Counters {
  framesSeen: number;
  duplicateTicks: number;
  staleTicks: number;
  unknownFrames: number;
}

export interface PersistedFeed {
  version: 1;
  tabs: { tabId: number; socketUrls: string[]; viewing: string | null; lastFrameAt: number; frames: number }[];
  assets: { asset: string; lastTickLocal: number; lastTs: number | null; tabs: [number, number][] }[];
  unknown: [string, number][];
  decoder: DecoderStats;
  counters: Counters;
  errors: string[];
}

export class FeedProcessor {
  readonly decoder = new QuotexDecoder();
  readonly offset = new OffsetEstimator();
  readonly gate = new TickGate();
  private readonly tabs = new Map<number, TabState>();
  private readonly assets = new Map<string, AssetState>();
  private readonly sockets = new Map<string, { asm: BinaryAssembler; lastSeen: number }>();
  private counters: Counters = { framesSeen: 0, duplicateTicks: 0, staleTicks: 0, unknownFrames: 0 };
  private orphanBinariesGone = 0;
  private lastClockTs = -Infinity;
  errors: string[] = [];
  /** Set whenever state worth persisting changed. */
  dirty = false;

  constructor(private readonly deps: FeedDeps) {}

  noteError(where: string, err: unknown, now: number): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.errors.push(`${new Date(now).toISOString().slice(11, 19)}Z ${where}: ${msg}`.slice(0, 300));
    if (this.errors.length > MAX_ERRORS) this.errors.shift();
    this.dirty = true;
  }

  serverNow(localNow: number): number {
    return localNow + (this.offset.offset() ?? 0);
  }

  async handleBatch(tabId: number, frameId: number, batch: TapBatch, now: number): Promise<void> {
    const tab = this.tab(tabId);
    let rec = checkRecorder(this.deps.getRecorder(), now);
    let room = allowance(rec);
    const records: Omit<RawFrameRecord, 'seq'>[] = [];
    let bytes = 0;
    const events: MarketEvent[] = [];

    for (const f of batch.frames) {
      this.counters.framesSeen++;
      tab.frames++;
      tab.lastFrameAt = Math.max(tab.lastFrameAt, now);
      const socketUrl = redactUrl(f.url);
      tab.socketUrls.add(socketUrl);
      const sock = this.socket(tabId, frameId, f.sid, now);
      const stored = redactFrame({ encoding: f.enc, data: f.data }, sock.asm.pendingEventName()).value;
      if (room > 0) {
        const r = { receivedAt: f.t, tabId, socketUrl, dir: f.dir, encoding: stored.encoding, data: stored.data };
        records.push(r);
        bytes += frameBytes(r);
        room--;
      }
      // Decode the redacted frame, so re-decoding the recording later gives the same events.
      const pkt = parseFrame(stored);
      if (pkt.type === 'unknown') this.counters.unknownFrames++;
      const ev = sock.asm.push(pkt);
      if (!ev) continue;
      const res = this.decoder.decode(ev, f.dir, this.serverNow(f.t));
      if (res.viewing) tab.viewing = res.viewing;
      for (const me of res.events) {
        if (me.kind === 'tick') {
          this.offset.add(me.ts, f.t);
          const a = this.asset(me.asset);
          a.lastTickLocal = Math.max(a.lastTickLocal, f.t);
          a.tabs.set(tabId, f.t);
          const verdict = this.gate.accept(me.asset, me.ts);
          if (verdict === 'duplicate') {
            this.counters.duplicateTicks++;
            continue;
          }
          if (verdict === 'stale') {
            this.counters.staleTicks++;
            continue;
          }
        }
        events.push(me);
      }
    }
    this.dirty = true;

    if (records.length > 0) {
      try {
        await this.deps.frames.appendRawFrames(records);
        rec = recordFrames(rec, records.length, bytes);
      } catch (err) {
        this.noteError('recording raw frames', err, now);
      }
    }
    this.deps.setRecorder(checkRecorder(rec, now));
    await this.emit(events, now);
  }

  handleStatus(tabId: number, frameId: number, status: TapStatus): void {
    this.tab(tabId).tap.set(frameId, status);
    this.dirty = true;
  }

  /** A clock event while any tab is feeding and the server offset is known; never goes backwards. */
  clockEvent(now: number): MarketEvent | null {
    const offset = this.offset.offset();
    if (offset === null || !this.isFeedActive(now)) return null;
    const ts = Math.round(now + offset);
    if (ts <= this.lastClockTs) return null;
    this.lastClockTs = ts;
    return { kind: 'clock', ts };
  }

  async emit(events: MarketEvent[], now: number): Promise<void> {
    try {
      for (const e of events) await this.deps.sink.onEvent(e);
      await this.deps.sink.flush?.();
    } catch (err) {
      this.noteError('sink', err, now);
    }
  }

  isFeedActive(now: number): boolean {
    for (const t of this.tabs.values()) if (now - t.lastFrameAt <= FEED_ACTIVE_MS) return true;
    return false;
  }

  removeTab(tabId: number): void {
    this.tabs.delete(tabId);
    for (const key of [...this.sockets.keys()]) if (key.startsWith(`${tabId}:`)) this.sockets.delete(key);
    for (const a of this.assets.values()) a.tabs.delete(tabId);
    this.dirty = true;
  }

  /** Drops parser state of sockets that went quiet. */
  sweep(now: number): void {
    for (const [key, s] of this.sockets) {
      if (now - s.lastSeen > SOCKET_IDLE_MS) {
        this.orphanBinariesGone += s.asm.orphanBinaries;
        this.sockets.delete(key);
      }
    }
  }

  // ---- views for the panel ----

  tabViews(): TabInfo[] {
    return [...this.tabs.values()]
      .sort((a, b) => a.tabId - b.tabId)
      .map((t) => {
        const taps = [...t.tap.values()];
        const assets = [...this.assets.entries()].filter(([, a]) => a.tabs.has(t.tabId)).map(([asset]) => asset).sort();
        return {
          tabId: t.tabId,
          socketUrls: [...t.socketUrls],
          viewing: t.viewing,
          assets,
          lastFrameAt: t.lastFrameAt,
          frames: t.frames,
          tap: taps.length === 0 ? null : {
            sockets: taps.reduce((n, s) => n + s.sockets, 0),
            errors: taps.reduce((n, s) => n + s.errors, 0),
            dropped: taps.reduce((n, s) => n + s.dropped, 0),
          },
        };
      });
  }

  /** Assets seen this session with their last tick time and the tabs currently feeding them. */
  assetViews(now: number): { asset: string; lastTickLocal: number; tabs: number[] }[] {
    return [...this.assets.entries()].map(([asset, a]) => ({
      asset,
      lastTickLocal: a.lastTickLocal,
      tabs: [...a.tabs.entries()].filter(([, t]) => now - t <= FEEDING_WINDOW_MS).map(([id]) => id).sort((x, y) => x - y),
    }));
  }

  decodeView(): DecodeView {
    const s = this.decoder.stats;
    let orphans = this.orphanBinariesGone;
    for (const sock of this.sockets.values()) orphans += sock.asm.orphanBinaries;
    return {
      ticks: s.ticks,
      duplicateTicks: this.counters.duplicateTicks,
      staleTicks: this.counters.staleTicks,
      ticksRejected: s.ticksRejected,
      candles: s.candles,
      candlesRejected: s.candlesRejected,
      candlesSkippedOpen: s.candlesSkippedOpen,
      payouts: s.payouts,
      badPayloads: s.badPayloads,
      orphanBinaries: orphans,
      unknownFrames: this.counters.unknownFrames,
    };
  }

  unknownEvents(): { name: string; count: number }[] {
    return [...this.decoder.unknown.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
  }

  get framesSeen(): number {
    return this.counters.framesSeen;
  }

  // ---- persistence across worker restarts ----

  persist(): PersistedFeed {
    return {
      version: 1,
      tabs: [...this.tabs.values()].map((t) => ({ tabId: t.tabId, socketUrls: [...t.socketUrls], viewing: t.viewing, lastFrameAt: t.lastFrameAt, frames: t.frames })),
      assets: [...this.assets.entries()].map(([asset, a]) => ({ asset, lastTickLocal: a.lastTickLocal, lastTs: this.gate.lastTs(asset) ?? null, tabs: [...a.tabs.entries()] })),
      unknown: [...this.decoder.unknown.entries()],
      decoder: { ...this.decoder.stats },
      counters: { ...this.counters },
      errors: [...this.errors],
    };
  }

  restore(p: PersistedFeed): void {
    if (p?.version !== 1) return;
    for (const t of p.tabs) {
      this.tabs.set(t.tabId, { tabId: t.tabId, socketUrls: new Set(t.socketUrls), viewing: t.viewing, lastFrameAt: t.lastFrameAt, frames: t.frames, tap: new Map() });
    }
    for (const a of p.assets) {
      this.assets.set(a.asset, { lastTickLocal: a.lastTickLocal, tabs: new Map(a.tabs) });
      if (a.lastTs !== null) this.gate.seed(a.asset, a.lastTs);
    }
    for (const [k, v] of p.unknown) this.decoder.unknown.set(k, v);
    Object.assign(this.decoder.stats, p.decoder);
    this.counters = { ...this.counters, ...p.counters };
    this.errors = [...p.errors];
  }

  // ---- internals ----

  private tab(tabId: number): TabState {
    let t = this.tabs.get(tabId);
    if (!t) {
      t = { tabId, socketUrls: new Set(), viewing: null, lastFrameAt: 0, frames: 0, tap: new Map() };
      this.tabs.set(tabId, t);
    }
    return t;
  }

  private asset(asset: string): AssetState {
    let a = this.assets.get(asset);
    if (!a) {
      a = { lastTickLocal: 0, tabs: new Map() };
      this.assets.set(asset, a);
    }
    return a;
  }

  private socket(tabId: number, frameId: number, sid: number, now: number) {
    const key = `${tabId}:${frameId}:${sid}`;
    let s = this.sockets.get(key);
    if (!s) {
      s = { asm: new BinaryAssembler(), lastSeen: now };
      this.sockets.set(key, s);
    }
    s.lastSeen = now;
    return s;
  }
}
