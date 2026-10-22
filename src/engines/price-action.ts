// Engine 1, price action (direction voter). Hand-coded rules over the feature library, gated by the
// feed-structure label in ctx.feed. Not ML, no learning: onOutcome only keeps statistics.
//
// mean-reverting feed: band-fade, streak-fade, wick-rejection, rsi-fade (each fades an extreme)
// trending feed:       trend-follow (EMA 9/21 spread and slow slope agree with the 5m and 15m regimes)
// label 'none':        ABSTAIN
// Rules that fire in opposite directions make the engine ABSTAIN. Agreement between rules does not
// raise confidence (that would be indicator confluence); confidence depends only on feed strength.
// Votes use closed candles only; ctx.forming is never read.

import {
  TF_MS,
  type Candle, type Context, type Direction, type Engine, type EngineFactory, type EngineStats, type FeedStructure, type Outcome, type Vote,
} from '../core/contracts';
import { aggregate } from '../features/aggregate';
import { bollinger, type Bollinger } from '../features/bollinger';
import { candleShape, type CandleShape } from '../features/candle-shape';
import { DEFAULT_EMA_TREND, emaTrend, type EmaTrend, type EmaTrendOptions } from '../features/ema-trend';
import { efficiencyRatio, type Efficiency } from '../features/regime';
import { rsi } from '../features/rsi';
import { closes } from '../features/series';
import { streak, type Streak } from '../features/streak';
import { StatsTracker } from './stats-tracker';

export const PRICE_ACTION_ID = 'price-action';

export type RuleName = 'band-fade' | 'streak-fade' | 'wick-rejection' | 'rsi-fade' | 'trend-follow';
export const RULES: readonly RuleName[] = ['band-fade', 'streak-fade', 'wick-rejection', 'rsi-fade', 'trend-follow'];

export interface PriceActionOptions {
  /** Closed candles the features look at; long enough for Wilder / EMA smoothing to forget its seed. */
  lookback: number;
  bbPeriod: number;
  bbMult: number;
  rsiPeriod: number;
  ema: EmaTrendOptions;
  /** Rules switched on. */
  rules: readonly RuleName[];
  /** band-fade fires when %B > 1 + bandExcess or < -bandExcess. */
  bandExcess: number;
  /** streak-fade fires on a run of at least this many same-coloured closed candles. */
  streakMin: number;
  /** wick-rejection: wick >= wickToBody * body and wick >= wickFrac * range, and the wick pierced the band. */
  wickToBody: number;
  wickFrac: number;
  /** rsi-fade fires at RSI >= rsiHigh or <= rsiLow. */
  rsiHigh: number;
  rsiLow: number;
  /** trend-follow: efficiency-ratio horizons in 5m and 15m bars, and the minimum ER on both. */
  regime5Bars: number;
  regime15Bars: number;
  regimeEr: number;
  /** Labels weaker than this are treated as 'none'. */
  minFeedStrength: number;
  /** Confidence = confMin + (confMax - confMin) * feed strength. */
  confMin: number;
  confMax: number;
}

export const DEFAULT_PRICE_ACTION: PriceActionOptions = {
  lookback: 240,       // TUNABLE: Wilder RSI / ATR seed weight after 240 steps is (13/14)^226, about 5e-8
  bbPeriod: 20,
  bbMult: 2,
  rsiPeriod: 14,
  ema: DEFAULT_EMA_TREND,
  rules: RULES,
  bandExcess: 0,       // TUNABLE: fade any close outside the 2-sd band; 0.1 bought nothing on the tuning seed
  streakMin: 4,        // TUNABLE: votes skip the forming candle, and fade-after-3 then reached only 52.4% at k = 0.08 on the tuning seed (4: 53.8%)
  wickToBody: 2,       // TUNABLE: a rejection wick at least twice the body
  wickFrac: 0.5,       // TUNABLE: and at least half the candle's range
  rsiHigh: 70,         // TUNABLE: classic level; 75 almost never fired on a mean-reverting fixture
  rsiLow: 30,          // TUNABLE: mirror of rsiHigh
  regime5Bars: 6,      // TUNABLE: 30 minutes of 5m bars
  regime15Bars: 8,     // TUNABLE: two hours of 15m bars; a longer horizon gets the drift sign right more often (4 bars: 52.8%, 8: 53.4% on the tuning seed)
  regimeEr: 0.2,       // TUNABLE: below this the higher timeframe is ranging, not trending; 0.1-0.3 made no difference on the tuning seed
  minFeedStrength: 0,  // TUNABLE: trust any label the feed-structure engine is willing to give
  confMin: 0.52,       // TUNABLE: modest; a label at its threshold is weak evidence
  confMax: 0.58,       // TUNABLE: about the accuracy fade rules reach on a strongly bounded fixture
};

/** Closed candles needed before the slowest feature (the 15m regime) exists, plus the slowest base-timeframe feature. */
export function priceActionWarmup(o: PriceActionOptions, tf: Context['tf'] = '1m'): number {
  const fifteen = 15 * 60_000;
  const per15 = fifteen / TF_MS[tf];
  // 15m bars for the regime, plus worst-case alignment to a 15m boundary; none if 15m is not a multiple of tf
  const regime = fifteen % TF_MS[tf] === 0 ? per15 * (o.regime15Bars + 1) + per15 - 1 : 0;
  return Math.max(regime, o.bbPeriod, o.rsiPeriod + 1, o.ema.slow + o.ema.slopeLag, o.ema.atrPeriod + 1);
}

export interface PriceActionFeatures {
  bb: Bollinger | null;
  rsi: number | null;
  ema: EmaTrend | null;
  shape: CandleShape;
  last: Candle;
  streak: Streak;
  r5: Efficiency | null;
  r15: Efficiency | null;
}

function regime(candles: readonly Candle[], baseMs: number, targetMs: number, bars: number): Efficiency | null {
  if (targetMs % baseMs !== 0) return null;
  return efficiencyRatio(closes(aggregate(candles, baseMs, targetMs)), bars);
}

export function computeFeatures(candles: readonly Candle[], tf: Context['tf'], o: PriceActionOptions): PriceActionFeatures {
  const cs = candles.slice(-Math.max(o.lookback, priceActionWarmup(o, tf)));
  const base = TF_MS[tf];
  const last = cs[cs.length - 1]!;
  return {
    bb: bollinger(cs, o.bbPeriod, o.bbMult),
    rsi: rsi(cs, o.rsiPeriod),
    ema: emaTrend(cs, o.ema),
    shape: candleShape(last),
    last,
    streak: streak(cs),
    r5: regime(cs, base, 5 * 60_000, o.regime5Bars),
    r15: regime(cs, base, 15 * 60_000, o.regime15Bars),
  };
}

export interface RuleHit { rule: RuleName; dir: 'UP' | 'DOWN'; reason: string }

const opposite = (d: 1 | -1): 'UP' | 'DOWN' => (d > 0 ? 'DOWN' : 'UP');
const toDir = (d: 1 | -1): 'UP' | 'DOWN' => (d > 0 ? 'UP' : 'DOWN');
const f2 = (x: number): string => x.toFixed(2);

function meanReversionRules(f: PriceActionFeatures, o: PriceActionOptions): RuleHit[] {
  const hits: RuleHit[] = [];
  if (f.bb) {
    const b = f.bb.percentB;
    if (b > 1 + o.bandExcess) hits.push({ rule: 'band-fade', dir: 'DOWN', reason: `band-fade: close above upper band, %B ${f2(b)} > ${f2(1 + o.bandExcess)}` });
    else if (b < -o.bandExcess) hits.push({ rule: 'band-fade', dir: 'UP', reason: `band-fade: close below lower band, %B ${f2(b)} < ${f2(-o.bandExcess)}` });
  }
  if (f.streak.colour !== 0 && f.streak.length >= o.streakMin) {
    const dir = opposite(f.streak.colour);
    hits.push({ rule: 'streak-fade', dir, reason: `streak-fade: ${f.streak.length} ${f.streak.colour > 0 ? 'green' : 'red'} candles in a row (>= ${o.streakMin})` });
  }
  if (f.bb) {
    const s = f.shape;
    const upper = s.upperToBody >= o.wickToBody && s.upperFrac >= o.wickFrac && f.last.high >= f.bb.upper;
    const lower = s.lowerToBody >= o.wickToBody && s.lowerFrac >= o.wickFrac && f.last.low <= f.bb.lower;
    if (upper && !lower) hits.push({ rule: 'wick-rejection', dir: 'DOWN', reason: `wick-rejection: upper wick ${f2(s.upperToBody)}x body, ${f2(s.upperFrac)} of range, high pierced the upper band` });
    if (lower && !upper) hits.push({ rule: 'wick-rejection', dir: 'UP', reason: `wick-rejection: lower wick ${f2(s.lowerToBody)}x body, ${f2(s.lowerFrac)} of range, low pierced the lower band` });
  }
  if (f.rsi !== null) {
    if (f.rsi >= o.rsiHigh) hits.push({ rule: 'rsi-fade', dir: 'DOWN', reason: `rsi-fade: RSI ${f.rsi.toFixed(1)} >= ${o.rsiHigh}` });
    else if (f.rsi <= o.rsiLow) hits.push({ rule: 'rsi-fade', dir: 'UP', reason: `rsi-fade: RSI ${f.rsi.toFixed(1)} <= ${o.rsiLow}` });
  }
  return hits;
}

function trendRules(f: PriceActionFeatures, o: PriceActionOptions): RuleHit[] {
  const { r5, r15, ema } = f;
  if (!r5 || !r15 || !ema || r5.dir === 0 || r5.dir !== r15.dir) return [];
  if (r5.er < o.regimeEr || r15.er < o.regimeEr) return [];
  const d = r5.dir;
  if (Math.sign(ema.spread) !== d || Math.sign(ema.slowSlope) !== d) return [];
  return [{
    rule: 'trend-follow',
    dir: toDir(d),
    reason: `trend-follow: 5m ER ${f2(r5.er)} and 15m ER ${f2(r15.er)} both ${d > 0 ? 'up' : 'down'} (>= ${f2(o.regimeEr)}), EMA 9/21 spread ${f2(ema.spread)} ATR, slow slope ${ema.slowSlope.toFixed(3)} ATR/candle`,
  }];
}

export function firedRules(f: PriceActionFeatures, feed: FeedStructure, o: PriceActionOptions): RuleHit[] {
  if (feed.strength < o.minFeedStrength) return [];
  const hits = feed.label === 'mean-reverting' ? meanReversionRules(f, o) : feed.label === 'trending' ? trendRules(f, o) : [];
  return hits.filter((h) => o.rules.includes(h.rule));
}

function featureRecord(f: PriceActionFeatures, feed: FeedStructure, hits: readonly RuleHit[]): Record<string, number> {
  const out: Record<string, number> = {
    bodyFrac: f.shape.bodyFrac, upperFrac: f.shape.upperFrac, lowerFrac: f.shape.lowerFrac,
    upperToBody: f.shape.upperToBody, lowerToBody: f.shape.lowerToBody,
    streakLength: f.streak.length, streakColour: f.streak.colour,
    feedStrength: feed.strength, feedMeanReverting: feed.label === 'mean-reverting' ? 1 : 0, feedTrending: feed.label === 'trending' ? 1 : 0,
  };
  if (f.bb) { out['percentB'] = f.bb.percentB; out['bandwidth'] = f.bb.bandwidth; }
  if (f.rsi !== null) out['rsi'] = f.rsi;
  if (f.ema) { out['emaSpread'] = f.ema.spread; out['emaFastSlope'] = f.ema.fastSlope; out['emaSlowSlope'] = f.ema.slowSlope; out['atr'] = f.ema.atr; }
  if (f.r5) { out['er5m'] = f.r5.er; out['dir5m'] = f.r5.dir; }
  if (f.r15) { out['er15m'] = f.r15.er; out['dir15m'] = f.r15.dir; }
  for (const r of RULES) {
    const h = hits.find((x) => x.rule === r);
    out[`rule:${r}`] = h ? (h.dir === 'UP' ? 1 : -1) : 0;
  }
  return out;
}

function abstain(reason: string, features?: Record<string, number>): Vote {
  return features
    ? { engine: PRICE_ACTION_ID, direction: 'ABSTAIN', confidence: 0.5, reasons: [reason], features }
    : { engine: PRICE_ACTION_ID, direction: 'ABSTAIN', confidence: 0.5, reasons: [reason] };
}

/** The whole decision, as a pure function of the context. */
export function decide(ctx: Context, o: PriceActionOptions = DEFAULT_PRICE_ACTION): Vote {
  const warmup = priceActionWarmup(o, ctx.tf);
  if (ctx.candles.length < warmup) return abstain(`warming up: ${ctx.candles.length}/${warmup} closed candles`);
  const f = computeFeatures(ctx.candles, ctx.tf, o);
  const hits = firedRules(f, ctx.feed, o);
  const features = featureRecord(f, ctx.feed, hits);
  const feedNote = `feed ${ctx.feed.label}, strength ${f2(ctx.feed.strength)}`;
  if (ctx.feed.label === 'none') return abstain(`no structure: ${feedNote}`, features);
  if (hits.length === 0) return abstain(`no rule fired (${feedNote})`, features);
  const dirs = new Set<Direction>(hits.map((h) => h.dir));
  if (dirs.size > 1) return abstain(`rules disagree: ${hits.map((h) => `${h.rule} ${h.dir}`).join(', ')} (${feedNote})`, features);
  const direction = hits[0]!.dir;
  const s = Math.max(0, Math.min(1, ctx.feed.strength));
  return {
    engine: PRICE_ACTION_ID,
    direction,
    confidence: o.confMin + (o.confMax - o.confMin) * s,
    reasons: [`${direction} via ${hits.map((h) => h.rule).join(' + ')} (${feedNote})`, ...hits.map((h) => h.reason)],
    features,
  };
}

export function createPriceActionEngine(opts: Partial<PriceActionOptions> = {}): Engine {
  const o: PriceActionOptions = { ...DEFAULT_PRICE_ACTION, ...opts };
  const tracker = new StatsTracker();
  return {
    id: PRICE_ACTION_ID,
    kind: 'direction',
    warmupCandles: priceActionWarmup(o, '1m'),
    vote: (ctx) => decide(ctx, o),
    onOutcome(vote: Vote, outcome: Outcome, ctx: Context): void {
      tracker.record(ctx.asset, vote, outcome);
    },
    stats(asset: string): EngineStats {
      return tracker.stats(asset);
    },
    serialize(): unknown {
      return { tracker: tracker.serialize() };
    },
    restore(state: unknown): void {
      tracker.restore((state as { tracker?: unknown } | null)?.tracker);
    },
  };
}

export const priceActionFactory: EngineFactory = (_seed: number) => createPriceActionEngine();
