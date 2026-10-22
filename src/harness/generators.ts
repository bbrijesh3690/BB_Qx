// Synthetic price feeds for the replay harness (BB_Qx.md: random walk, bounded, trending,
// regime-switching). Per candle, on log price:
//
//   x[t+1] = x[t] + drift - k * (x[t] - anchor) + sigma * eps,   eps ~ N(0, 1)
//
// Each candle's open is the previous close. Ticks inside a candle follow a Brownian bridge from the
// open to the close: the first tick sits exactly at openTs at the open price, the last tick carries
// the close price before the boundary. Everything is deterministic for a seed; each asset draws from
// its own streams, so adding an asset never changes another asset's prices.

import { TF_MS, type Candle, type MarketEvent, type SourceAsset, type Tick, type Timeframe } from '../core/contracts';
import { hashSeed, Rng } from '../core/rng';
import { liveMarketOpen } from '../core/time';
import { TUNABLES } from '../core/tunables';

/** Monday 2026-01-05 00:00 UTC, so synthetic candles span real calendar days and weekdays. */
export const SYNTHETIC_START_TS = Date.UTC(2026, 0, 5);

export type RegimeKind = 'random' | 'bounded' | 'trending';
export interface Regime { kind: RegimeKind; drift: number; k: number }

export interface PriceModel {
  readonly id: string;
  /** Regime of candle i (0-based, counted in time from the start). */
  regimeAt(i: number): Regime;
  /** True when candle i starts a segment whose anchor resets to the current price. */
  reanchorAt(i: number): boolean;
}

const RANDOM: Regime = { kind: 'random', drift: 0, k: 0 };

export function randomWalk(): PriceModel {
  return { id: 'random', regimeAt: () => RANDOM, reanchorAt: (i) => i === 0 };
}

/** Pulls price toward the starting level; lag-1 autocorrelation of returns is about -k/2. */
export function bounded(k: number = TUNABLES.syntheticBoundedK.value): PriceModel { // TUNABLE: syntheticBoundedK
  const r: Regime = { kind: 'bounded', drift: 0, k };
  return { id: `bounded:k=${k}`, regimeAt: () => r, reanchorAt: (i) => i === 0 };
}

/** Constant drift per candle: P(up) = Phi(drift / sigma). */
export function trending(drift: number = TUNABLES.syntheticTrendDrift.value): PriceModel { // TUNABLE: syntheticTrendDrift
  const r: Regime = { kind: 'trending', drift, k: 0 };
  return { id: `trending:drift=${drift}`, regimeAt: () => r, reanchorAt: (i) => i === 0 };
}

export interface RegimeSchedule {
  /** Candles per segment; an array is cycled. Segments go random, bounded, trending, random, ... */
  segmentCandles?: number | number[];
  k?: number;
  drift?: number;
}

export function regimeSwitching(schedule: RegimeSchedule = {}): PriceModel {
  const lengths = ([] as number[]).concat(schedule.segmentCandles ?? TUNABLES.syntheticRegimeCandles.value); // TUNABLE: syntheticRegimeCandles
  if (!lengths.length || lengths.some((n) => !(Number.isInteger(n) && n > 0))) throw new Error('regimeSwitching: segment lengths must be positive integers');
  const k = schedule.k ?? TUNABLES.syntheticBoundedK.value;
  const drift = schedule.drift ?? TUNABLES.syntheticTrendDrift.value;
  const regimes: Regime[] = [RANDOM, { kind: 'bounded', drift: 0, k }, { kind: 'trending', drift, k: 0 }];
  // The (regime, length) pattern repeats every 3 * lengths.length segments.
  const periodSegments = lengths.length * 3;
  const segLen = (s: number) => lengths[s % lengths.length]!;
  let period = 0;
  for (let s = 0; s < periodSegments; s++) period += segLen(s);
  const locate = (i: number): { seg: number; start: boolean } => {
    let r = i % period;
    for (let s = 0; ; s++) {
      const len = segLen(s);
      if (r < len) return { seg: s, start: r === 0 };
      r -= len;
    }
  };
  return {
    id: `regime:${lengths.join('/')}:k=${k}:drift=${drift}`,
    regimeAt: (i) => regimes[locate(i).seg % 3]!,
    reanchorAt: (i) => locate(i).start,
  };
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export interface PayoutStep { fromCandle: number; percent: number }

export interface SyntheticAsset {
  asset: string;
  isOTC: boolean;
  /** Constant percent, or steps starting at a candle index. Default by class (see tunables). */
  payout?: number | PayoutStep[];
  startPrice?: number;
}

export interface SyntheticOptions {
  /** Candle slots per asset, counted in time from startTs. */
  candles: number;
  assets?: SyntheticAsset[];
  tf?: Timeframe;
  sigma?: number;
  ticksPerCandle?: number;
  /** Quote precision; null keeps raw prices (no ties). */
  decimals?: number | null;
  startTs?: number;
  /** Live assets go quiet while the live market is closed (weekends). Default false. */
  marketHours?: boolean;
}

export const DEFAULT_ASSETS: readonly SyntheticAsset[] = [
  { asset: 'EURUSD_otc', isOTC: true, startPrice: 1.085 },
  { asset: 'GBPUSD_otc', isOTC: true, startPrice: 1.27 },
  { asset: 'EURUSD', isOTC: false, startPrice: 1.085 },
  { asset: 'GBPUSD', isOTC: false, startPrice: 1.27 },
];

interface Resolved {
  candles: number; tf: Timeframe; tfMs: number; sigma: number; ticks: number; decimals: number | null;
  startTs: number; marketHours: boolean; assets: SyntheticAsset[];
}

function resolve(o: SyntheticOptions): Resolved {
  const r: Resolved = {
    candles: o.candles,
    tf: o.tf ?? '1m',
    tfMs: TF_MS[o.tf ?? '1m'],
    sigma: o.sigma ?? TUNABLES.syntheticSigma.value, // TUNABLE: syntheticSigma
    ticks: o.ticksPerCandle ?? TUNABLES.syntheticTicksPerCandle.value, // TUNABLE: syntheticTicksPerCandle
    decimals: o.decimals === undefined ? TUNABLES.syntheticDecimals.value : o.decimals, // TUNABLE: syntheticDecimals
    startTs: o.startTs ?? SYNTHETIC_START_TS,
    marketHours: o.marketHours ?? false,
    assets: (o.assets ?? DEFAULT_ASSETS).map((a) => ({ ...a })),
  };
  if (!(Number.isInteger(r.candles) && r.candles >= 0)) throw new Error('synthetic: candles must be a non-negative integer');
  if (!(Number.isInteger(r.ticks) && r.ticks >= 2)) throw new Error('synthetic: ticksPerCandle must be an integer >= 2');
  if (!(r.sigma > 0)) throw new Error('synthetic: sigma must be > 0');
  if (new Set(r.assets.map((a) => a.asset)).size !== r.assets.length) throw new Error('synthetic: duplicate asset ids');
  return r;
}

/** Payout schedule of an asset, sorted by candle index. */
export function payoutSteps(a: SyntheticAsset): PayoutStep[] {
  const fallback = a.isOTC ? TUNABLES.syntheticPayoutOtcPercent.value : TUNABLES.syntheticPayoutLivePercent.value; // TUNABLE: syntheticPayoutOtcPercent, syntheticPayoutLivePercent
  const p = a.payout ?? fallback;
  const steps = typeof p === 'number' ? [{ fromCandle: 0, percent: p }] : p.map((s) => ({ ...s }));
  return steps.sort((x, y) => x.fromCandle - y.fromCandle);
}

export function sourceAssets(o: SyntheticOptions): SourceAsset[] {
  return resolve(o).assets.map((a) => ({ asset: a.asset, isOTC: a.isOTC, payoutPercent: payoutSteps(a)[0]?.percent ?? 0 }));
}

export interface CandleTicks { index: number; openTs: number; ticks: Tick[] }

/** The candles of one asset with their ticks, oldest first. Closed live-market slots are skipped. */
export function* assetPath(model: PriceModel, seed: number, asset: SyntheticAsset, opts: SyntheticOptions): Generator<CandleTicks> {
  const o = resolve(opts);
  const pathRng = new Rng(hashSeed(seed, asset.asset, 'path'));
  const tickRng = new Rng(hashSeed(seed, asset.asset, 'ticks'));
  const factor = o.decimals === null ? 0 : 10 ** o.decimals;
  const quote = (x: number) => (factor ? Math.round(Math.exp(x) * factor) / factor : Math.exp(x));
  const n = o.ticks;
  const steps = n - 1;
  const stepSd = o.sigma / Math.sqrt(steps);
  const w = new Array<number>(n).fill(0);
  let x = Math.log(asset.startPrice ?? 1.1);
  let anchor = x;
  for (let i = 0; i < o.candles; i++) {
    if (model.reanchorAt(i)) anchor = x;
    const openTs = o.startTs + i * o.tfMs;
    if (o.marketHours && !asset.isOTC && !liveMarketOpen(openTs)) continue;
    const { drift, k } = model.regimeAt(i);
    const next = x + drift - k * (x - anchor) + o.sigma * pathRng.normal();
    // Brownian bridge: a random walk W pinned to 0 at both ends, added to the straight line open -> close.
    for (let j = 1; j < n; j++) w[j] = w[j - 1]! + stepSd * tickRng.normal();
    const end = w[steps]!;
    const ticks: Tick[] = new Array(n);
    for (let j = 0; j < n; j++) {
      const f = j / steps;
      const xj = j === 0 ? x : j === steps ? next : x + f * (next - x) + w[j]! - f * end;
      ticks[j] = { ts: openTs + Math.floor((j * o.tfMs) / n), price: quote(xj) };
    }
    x = next;
    yield { index: i, openTs, ticks };
  }
}

/** Candles of one asset, built from its ticks exactly as the candle builder would. */
export function syntheticCandles(model: PriceModel, seed: number, asset: SyntheticAsset, opts: SyntheticOptions): Candle[] {
  const out: Candle[] = [];
  for (const { openTs, ticks } of assetPath(model, seed, asset, opts)) {
    let high = -Infinity, low = Infinity;
    for (const t of ticks) {
      if (t.price > high) high = t.price;
      if (t.price < low) low = t.price;
    }
    out.push({ openTs, open: ticks[0]!.price, high, low, close: ticks[ticks.length - 1]!.price, tickCount: ticks.length });
  }
  return out;
}

/**
 * Market events for every asset, ordered by ts. At equal ts, payouts come before ticks and assets
 * keep their listed order.
 */
export function* syntheticEvents(model: PriceModel, seed: number, opts: SyntheticOptions): Generator<MarketEvent> {
  const o = resolve(opts);
  const lanes = o.assets.map((a) => ({
    a,
    path: assetPath(model, seed, a, opts),
    next: null as CandleTicks | null,
    payouts: payoutSteps(a),
    payoutIdx: 0,
  }));
  for (const lane of lanes) {
    const r = lane.path.next();
    lane.next = r.done ? null : r.value;
  }
  for (let i = 0; i < o.candles; i++) {
    const openTs = o.startTs + i * o.tfMs;
    const active: CandleTicks[] = [];
    const activeAssets: SyntheticAsset[] = [];
    for (const lane of lanes) {
      while (lane.payoutIdx < lane.payouts.length && lane.payouts[lane.payoutIdx]!.fromCandle <= i) {
        const step = lane.payouts[lane.payoutIdx++]!;
        yield { kind: 'payout', asset: lane.a.asset, isOTC: lane.a.isOTC, ts: openTs, percent: step.percent };
      }
      if (lane.next && lane.next.index === i) {
        active.push(lane.next);
        activeAssets.push(lane.a);
        const r = lane.path.next();
        lane.next = r.done ? null : r.value;
      }
    }
    for (let j = 0; j < o.ticks; j++) {
      for (let k = 0; k < active.length; k++) {
        const t = active[k]!.ticks[j]!;
        const a = activeAssets[k]!;
        yield { kind: 'tick', asset: a.asset, isOTC: a.isOTC, ts: t.ts, price: t.price };
      }
    }
  }
}
