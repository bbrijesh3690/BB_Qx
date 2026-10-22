// Engine 6, feed-structure (context). Describes the feed from a rolling window of closed candles and
// labels it mean-reverting / trending / none. It never votes a direction.
//
// Label channels, each a z statistic against its own threshold (calibrated on random-walk fixture
// windows, seed base 1, so that the total false-call rate stays well under 5%):
//   mean-reverting: VR(primaryQ) z* <= -mrVrZ with negative autocorr sum, or runs z >= runsZ
//   trending:       VR(primaryQ) z* >= momVrZ with positive autocorr sum, or runs z <= -runsZ,
//                   or |drift t| >= driftZ
// The long-horizon variance ratio carries most of the power on an anchor-pulling feed: at k = 0.08
// lag-1 autocorrelation alone gives z of about -1.3 over 1000 candles, VR(16) about -3.0, because
// the pull shows up as a small negative autocorrelation at every lag and VR(q) sums them.
// The runs channel covers feeds whose structure lives in candle colours rather than price levels.
//
// strength = 1 - p / p_crit for the most significant firing channel, with p the normal-approximation
// one-sided tail of its z and p_crit the tail at its threshold: 0 at the threshold, toward 1 as the
// evidence grows. 'none' has strength 0.

import {
  NEUTRAL_FEED,
  type Context, type EngineStats, type FeedLabel, type FeedStructure, type FeedStructureEngine, type Outcome, type Vote,
} from '../core/contracts';
import { computeFeedStats, normalTail, type FeedStats } from './feed-stats';
import { StatsTracker } from './stats-tracker';

export const FEED_STRUCTURE_ID = 'feed-structure';

export interface FeedStructureOptions {
  /** Log returns in the rolling window. */
  windowSize: number;
  /** Closed candles before the engine says anything. */
  warmup: number;
  maxLag: number;
  /** Variance-ratio horizons reported in features; primaryQ must be one of them. */
  vrQs: readonly number[];
  primaryQ: number;
  minStreak: number;
  mrVrZ: number;
  momVrZ: number;
  runsZ: number;
  driftZ: number;
}

export const DEFAULT_FEED_STRUCTURE: FeedStructureOptions = {
  windowSize: 1000, // TUNABLE: brief range 200-1000; longer buys power on weak drift (see tests), costs reaction time
  warmup: 200,      // TUNABLE: brief's lower window bound; thresholds are conservative below 1000 returns
  maxLag: 5,
  vrQs: [2, 4, 8, 16],
  primaryQ: 16,     // TUNABLE: covers anchor pulls with k from about 0.05 up; smaller q loses power, larger q skews the null at small windows
  minStreak: 3,
  mrVrZ: 2.2,       // TUNABLE: random-walk VR(16) z* lower 1% quantile is about -2.14 at W = 1000 (thinner at smaller W)
  momVrZ: 3.0,      // TUNABLE: VR(16) z* null is right-skewed (99% quantile 2.8 at W = 1000, 3.2 at W = 200)
  runsZ: 2.8,       // TUNABLE: about 0.3% per side on random walk
  driftZ: 2.8,      // TUNABLE: about 0.5% two-sided on random walk
};

export interface FeedAssessment { structure: FeedStructure; stats: FeedStats | null; mrStrength: number; trendStrength: number }

/** 1 - p / p_crit, 0 when z does not clear the threshold. */
export function significanceStrength(z: number, threshold: number): number {
  if (z < threshold) return 0;
  return Math.max(0, Math.min(1, 1 - normalTail(z) / normalTail(threshold)));
}

export function labelFeed(s: FeedStats, o: FeedStructureOptions): FeedAssessment {
  const qi = o.vrQs.indexOf(o.primaryQ);
  const vrZ = s.vrZ[qi] ?? 0;
  const acSum = s.autocorr.reduce((a, b) => a + b, 0);
  const mrStrength = Math.max(
    acSum < 0 ? significanceStrength(-vrZ, o.mrVrZ) : 0,
    significanceStrength(s.runsZ, o.runsZ),
  );
  const trendStrength = Math.max(
    acSum > 0 ? significanceStrength(vrZ, o.momVrZ) : 0,
    significanceStrength(-s.runsZ, o.runsZ),
    significanceStrength(Math.abs(s.driftZ), o.driftZ),
  );
  // A channel at exactly its threshold has strength 0 but still fires; compare firing first.
  const mrFires = (acSum < 0 && -vrZ >= o.mrVrZ) || s.runsZ >= o.runsZ;
  const trendFires = (acSum > 0 && vrZ >= o.momVrZ) || -s.runsZ >= o.runsZ || Math.abs(s.driftZ) >= o.driftZ;
  let label: FeedLabel = 'none';
  if (mrFires && (!trendFires || mrStrength >= trendStrength)) label = 'mean-reverting';
  else if (trendFires) label = 'trending';
  return {
    structure: {
      label,
      strength: label === 'mean-reverting' ? mrStrength : label === 'trending' ? trendStrength : 0,
      autocorr: [...s.autocorr],
      varianceRatio: s.vr[qi] ?? 1,
      runsZ: s.runsZ,
      streakReversalRate: s.streakReversalRate,
    },
    stats: s,
    mrStrength,
    trendStrength,
  };
}

export function assessFeed(candles: Context['candles'], o: FeedStructureOptions = DEFAULT_FEED_STRUCTURE): FeedAssessment {
  if (candles.length < o.warmup) {
    return { structure: { ...NEUTRAL_FEED, autocorr: [...NEUTRAL_FEED.autocorr] }, stats: null, mrStrength: 0, trendStrength: 0 };
  }
  const window = candles.slice(-(o.windowSize + 1));
  return labelFeed(computeFeedStats(window, { maxLag: o.maxLag, vrQs: o.vrQs, minStreak: o.minStreak }), o);
}

function featuresOf(a: FeedAssessment, o: FeedStructureOptions): Record<string, number> {
  const s = a.stats!;
  const f: Record<string, number> = { n: s.n };
  s.autocorr.forEach((x, i) => { f[`ac${i + 1}`] = x; });
  f['acSumZ'] = s.acSumZ;
  o.vrQs.forEach((q, i) => { f[`vr${q}`] = s.vr[i]!; f[`vrZ${q}`] = s.vrZ[i]!; });
  Object.assign(f, {
    runsZ: s.runsZ, streakReversalRate: s.streakReversalRate, streakEvents: s.streakEvents, streakZ: s.streakZ,
    driftZ: s.driftZ, mrStrength: a.mrStrength, trendStrength: a.trendStrength, strength: a.structure.strength,
    labelMeanReverting: a.structure.label === 'mean-reverting' ? 1 : 0, labelTrending: a.structure.label === 'trending' ? 1 : 0,
  });
  return f;
}

export function createFeedStructureEngine(opts: Partial<FeedStructureOptions> = {}): FeedStructureEngine {
  const o: FeedStructureOptions = { ...DEFAULT_FEED_STRUCTURE, ...opts };
  if (!o.vrQs.includes(o.primaryQ)) throw new RangeError(`primaryQ ${o.primaryQ} must be in vrQs`);
  const tracker = new StatsTracker();
  return {
    id: FEED_STRUCTURE_ID,
    kind: 'context',
    warmupCandles: o.warmup,
    structure(ctx: Context): FeedStructure {
      return assessFeed(ctx.candles, o).structure;
    },
    vote(ctx: Context): Vote {
      const a = assessFeed(ctx.candles, o);
      if (!a.stats) {
        return { engine: FEED_STRUCTURE_ID, direction: 'ABSTAIN', confidence: 0.5, reasons: [`warming up: ${ctx.candles.length}/${o.warmup} closed candles`] };
      }
      const s = a.stats;
      const z = s.vrZ[o.vrQs.indexOf(o.primaryQ)]!;
      return {
        engine: FEED_STRUCTURE_ID,
        direction: 'ABSTAIN',
        confidence: 0.5,
        reasons: [
          `feed ${a.structure.label} (strength ${a.structure.strength.toFixed(2)}) over ${s.n} returns`,
          `VR(${o.primaryQ}) ${a.structure.varianceRatio.toFixed(3)} z ${z.toFixed(2)}; lag-1 autocorr ${s.autocorr[0]!.toFixed(3)}; runs z ${s.runsZ.toFixed(2)}; drift z ${s.driftZ.toFixed(2)}; streak reversal ${(100 * s.streakReversalRate).toFixed(1)}% of ${s.streakEvents}`,
        ],
        features: featuresOf(a, o),
      };
    },
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

export const feedStructureFactory = (_seed: number): FeedStructureEngine => createFeedStructureEngine();
