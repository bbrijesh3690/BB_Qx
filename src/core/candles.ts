// Candle builder: per asset, from server-time ticks, for one timeframe.
//
// - Boundaries are server time modulo tf; a tick at exactly openTs belongs to the new candle.
// - open = first tick, close = last tick, high/low over the ticks, tickCount.
// - Ticks at or before the asset's last accepted tick are dropped (duplicates and out-of-order ticks,
//   which happen when two tabs feed the same asset), as are ticks for a candle that already closed.
// - Server time is global: a tick of any asset or a clock event past a boundary closes every
//   forming candle whose close time it passed.
// - A minute with no ticks produces no candle and a gap effect.
// - Feed candles win over rebuilt ones. When both exist for a key and differ by more than the
//   tolerance (or in colour), a mismatch effect is emitted.
//
// The builder is synchronous; callers drain the effects it queues (closed candles, gaps, mismatches).

import { TF_MS, type Candle, type CandleRecord, type Tick, type Timeframe } from './contracts';
import { openTsOf } from './time';
import { TUNABLES } from './tunables';

export type CandleSource = 'feed' | 'rebuilt';

export type BuilderEffect =
  | { kind: 'closed'; candle: CandleRecord }
  | { kind: 'gap'; asset: string; isOTC: boolean; tf: Timeframe; fromOpenTs: number; toOpenTs: number; missing: number }
  | {
      kind: 'mismatch'; asset: string; isOTC: boolean; tf: Timeframe; openTs: number;
      feed: Candle; rebuilt: Candle; maxRelDiff: number; colourDiffers: boolean;
    };

export interface DropCounts { duplicate: number; outOfOrder: number; late: number; invalid: number }

export interface CandleBuilderOptions {
  tf: Timeframe;
  /** Closed candles kept per asset (at least what Context needs). */
  historyCap?: number;
  /** Relative OHLC difference above which feed and rebuilt candles count as a mismatch. */
  mismatchRelTol?: number;
}

interface Forming { openTs: number; open: number; high: number; low: number; close: number; tickCount: number }

interface AssetState {
  asset: string;
  isOTC: boolean;
  lastTickTs: number;
  /** Ticks before this time belong to a candle that has closed. */
  floorTs: number;
  forming: Forming | null;
  ticks: Tick[];
  /** openTs of the latest candle built from ticks, for gap detection. */
  lastOpenTs: number | null;
  // Closed history, oldest first, as parallel arrays. `candles` holds the winning version (feed over rebuilt).
  candles: Candle[];
  sources: CandleSource[];
  rebuilt: (Candle | null)[];
  mismatchLogged: boolean[];
  /** Feed candles for keys that have not closed yet by our clock. */
  pendingFeed: Map<number, Candle>;
  drops: DropCounts;
}

const freezeCandle = (c: Candle): Candle =>
  Object.freeze({ openTs: c.openTs, open: c.open, high: c.high, low: c.low, close: c.close, tickCount: c.tickCount });

const colour = (c: Candle) => Math.sign(c.close - c.open);

export class CandleBuilder {
  readonly tf: Timeframe;
  private readonly tfMs: number;
  private readonly historyCap: number;
  private readonly relTol: number;
  private readonly states = new Map<string, AssetState>();
  private effects: BuilderEffect[] = [];
  private nowTs = -Infinity;

  constructor(opts: CandleBuilderOptions) {
    this.tf = opts.tf;
    this.tfMs = TF_MS[opts.tf];
    this.historyCap = opts.historyCap ?? TUNABLES.contextCandles.value;
    this.relTol = opts.mismatchRelTol ?? TUNABLES.candleMismatchRelTol.value; // TUNABLE: candleMismatchRelTol
  }

  /** Latest server time seen (ticks and advance calls). */
  get now(): number {
    return this.nowTs;
  }

  /** Effects queued since the last drain, in the order they happened. */
  drain(): BuilderEffect[] {
    const out = this.effects;
    this.effects = [];
    return out;
  }

  assets(): string[] {
    return [...this.states.keys()];
  }

  isOTC(asset: string): boolean | undefined {
    return this.states.get(asset)?.isOTC;
  }

  /** Feeds one tick. Returns false when the tick is dropped. */
  onTick(asset: string, isOTC: boolean, ts: number, price: number): boolean {
    const s = this.state(asset, isOTC);
    if (!Number.isFinite(ts) || !Number.isFinite(price)) { s.drops.invalid++; return false; }
    if (ts === s.lastTickTs) { s.drops.duplicate++; return false; }
    if (ts < s.lastTickTs) { s.drops.outOfOrder++; return false; }
    const openTs = openTsOf(ts, this.tf);
    if (ts < s.floorTs || openTs + this.tfMs <= this.nowTs) { s.drops.late++; return false; }
    this.advance(ts);
    if (s.forming && openTs > s.forming.openTs) this.closeForming(s);
    if (!s.forming) {
      if (s.lastOpenTs !== null && openTs > s.lastOpenTs + this.tfMs) {
        this.effects.push({
          kind: 'gap', asset, isOTC: s.isOTC, tf: this.tf, fromOpenTs: s.lastOpenTs + this.tfMs, toOpenTs: openTs,
          missing: (openTs - s.lastOpenTs - this.tfMs) / this.tfMs,
        });
      }
      s.forming = { openTs, open: price, high: price, low: price, close: price, tickCount: 1 };
      s.ticks = [Object.freeze({ ts, price })];
      s.lastOpenTs = openTs;
    } else {
      const f = s.forming;
      if (price > f.high) f.high = price;
      if (price < f.low) f.low = price;
      f.close = price;
      f.tickCount++;
      s.ticks.push(Object.freeze({ ts, price }));
    }
    s.lastTickTs = ts;
    return true;
  }

  /** Server time has reached `ts`: closes every forming candle whose close time has passed. */
  advance(ts: number): void {
    if (ts <= this.nowTs) return;
    this.nowTs = ts;
    for (const s of this.states.values()) {
      if (s.forming && s.forming.openTs + this.tfMs <= ts) this.closeForming(s);
      if (s.pendingFeed.size) this.releaseFeed(s);
    }
  }

  /** A closed candle reported by the feed. Other timeframes are ignored. */
  onFeedCandle(asset: string, isOTC: boolean, tf: Timeframe, candle: Candle): void {
    if (tf !== this.tf) return;
    const s = this.state(asset, isOTC);
    const valid = [candle.openTs, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite);
    if (!valid || candle.openTs % this.tfMs !== 0) { s.drops.invalid++; return; }
    const c = freezeCandle(candle);
    const stillOpen = (s.forming !== null && c.openTs >= s.forming.openTs) || c.openTs + this.tfMs > this.nowTs;
    if (stillOpen) s.pendingFeed.set(c.openTs, c);
    else this.mergeFeed(s, c);
  }

  /** The candle in progress for an asset, or null. */
  forming(asset: string): Candle | null {
    const f = this.states.get(asset)?.forming;
    return f ? { ...f } : null;
  }

  /** Ticks of the forming candle, oldest first. */
  formingTicks(asset: string): readonly Tick[] {
    return this.states.get(asset)?.ticks ?? [];
  }

  /** Closed candles, oldest first, feed values where the feed reported one. Do not mutate. */
  closed(asset: string): readonly Candle[] {
    return this.states.get(asset)?.candles ?? [];
  }

  /** One closed candle by open time, with the source of the values returned. */
  closedCandle(asset: string, openTs: number): { candle: Candle; source: CandleSource } | null {
    const s = this.states.get(asset);
    if (!s) return null;
    const i = indexOf(s.candles, openTs);
    return i < 0 ? null : { candle: s.candles[i]!, source: s.sources[i]! };
  }

  dropCounts(asset: string): DropCounts {
    const d = this.states.get(asset)?.drops;
    return d ? { ...d } : { duplicate: 0, outOfOrder: 0, late: 0, invalid: 0 };
  }

  // ---------------------------------------------------------------------------

  private state(asset: string, isOTC: boolean): AssetState {
    let s = this.states.get(asset);
    if (!s) {
      s = {
        asset, isOTC, lastTickTs: -Infinity, floorTs: -Infinity, forming: null, ticks: [], lastOpenTs: null,
        candles: [], sources: [], rebuilt: [], mismatchLogged: [], pendingFeed: new Map(),
        drops: { duplicate: 0, outOfOrder: 0, late: 0, invalid: 0 },
      };
      this.states.set(asset, s);
    }
    return s;
  }

  private closeForming(s: AssetState): void {
    const c = freezeCandle(s.forming!);
    s.forming = null;
    s.ticks = [];
    s.floorTs = c.openTs + this.tfMs;
    this.effects.push({ kind: 'closed', candle: { asset: s.asset, isOTC: s.isOTC, tf: this.tf, ...c, source: 'rebuilt' } });
    const i = this.insert(s, c, 'rebuilt');
    if (i >= 0) {
      s.rebuilt[i] = c;
      this.compare(s, i);
    }
    const feed = s.pendingFeed.get(c.openTs);
    if (feed) {
      s.pendingFeed.delete(c.openTs);
      this.mergeFeed(s, feed);
    }
  }

  private releaseFeed(s: AssetState): void {
    for (const [openTs, c] of [...s.pendingFeed].sort((a, b) => a[0] - b[0])) {
      if (s.forming && openTs >= s.forming.openTs) continue;
      if (openTs + this.tfMs > this.nowTs) continue;
      s.pendingFeed.delete(openTs);
      this.mergeFeed(s, c);
    }
  }

  private mergeFeed(s: AssetState, feed: Candle): void {
    const i = this.insert(s, feed, 'feed');
    if (i >= 0) this.compare(s, i);
  }

  /** Emits a mismatch once per key when a feed candle and a rebuilt one disagree. */
  private compare(s: AssetState, i: number): void {
    const feed = s.candles[i]!, rebuilt = s.rebuilt[i];
    if (s.sources[i] !== 'feed' || !rebuilt || s.mismatchLogged[i]) return;
    const maxRelDiff = Math.max(
      relDiff(feed.open, rebuilt.open), relDiff(feed.high, rebuilt.high),
      relDiff(feed.low, rebuilt.low), relDiff(feed.close, rebuilt.close),
    );
    const colourDiffers = colour(feed) !== colour(rebuilt);
    if (maxRelDiff > this.relTol || colourDiffers) {
      s.mismatchLogged[i] = true;
      this.effects.push({
        kind: 'mismatch', asset: s.asset, isOTC: s.isOTC, tf: this.tf, openTs: feed.openTs,
        feed: { ...feed }, rebuilt: { ...rebuilt }, maxRelDiff, colourDiffers,
      });
    }
  }

  /**
   * Puts a candle into the closed history at its sorted place. A rebuilt candle never replaces a
   * feed one. Returns the index, or -1 when the candle is older than everything kept.
   */
  private insert(s: AssetState, c: Candle, source: CandleSource): number {
    const arr = s.candles;
    let i = arr.length;
    while (i > 0 && arr[i - 1]!.openTs > c.openTs) i--;
    if (i > 0 && arr[i - 1]!.openTs === c.openTs) {
      const j = i - 1;
      if (source === 'feed' || s.sources[j] === 'rebuilt') {
        arr[j] = c;
        s.sources[j] = source;
      }
      return j;
    }
    if (i === 0 && arr.length >= this.historyCap) return -1;
    arr.splice(i, 0, c);
    s.sources.splice(i, 0, source);
    s.rebuilt.splice(i, 0, null);
    s.mismatchLogged.splice(i, 0, false);
    if (arr.length > this.historyCap + 256) {
      const cut = arr.length - this.historyCap;
      arr.splice(0, cut);
      s.sources.splice(0, cut);
      s.rebuilt.splice(0, cut);
      s.mismatchLogged.splice(0, cut);
      return i - cut;
    }
    return i;
  }
}

function relDiff(a: number, b: number): number {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale === 0 ? 0 : Math.abs(a - b) / scale;
}

function indexOf(arr: readonly Candle[], openTs: number): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    const t = arr[i]!.openTs;
    if (t === openTs) return i;
    if (t < openTs) return -1;
  }
  return -1;
}
