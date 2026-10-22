// Label rates of the feed-structure engine over many independent fixture windows.

import { assessFeed, DEFAULT_FEED_STRUCTURE, type FeedStructureOptions } from '../feed-structure';
import { feedOptions, generateCandles, type FeedKind, type GenOptions } from './generator';

export interface LabelRates {
  windows: number; meanReverting: number; trending: number; none: number; meanStrength: number;
  /** Lag-1 autocorrelation of each window, to compare against a lag-1-only rule. */
  ac1: number[];
}

/**
 * Each window is its own series (seeded from seedBase and the window index) with a 200-candle
 * burn-in, so bounded feeds start from their stationary spread and windows are independent.
 */
export function labelRates(
  kind: FeedKind, windows: number, seedBase: number,
  opts: Partial<FeedStructureOptions> = {}, gen: Partial<GenOptions> = {},
): LabelRates {
  const o = { ...DEFAULT_FEED_STRUCTURE, ...opts };
  const burnIn = 200;
  let mr = 0, tr = 0, strength = 0;
  const ac1: number[] = [];
  for (let w = 0; w < windows; w++) {
    const seed = (seedBase * 1_000_003 + w * 7919) >>> 0;
    const cs = generateCandles({ n: burnIn + o.windowSize + 1, seed, ...feedOptions(kind), ...gen }).slice(burnIn);
    const a = assessFeed(cs, o);
    if (a.structure.label === 'mean-reverting') mr++;
    else if (a.structure.label === 'trending') tr++;
    strength += a.structure.strength;
    ac1.push(a.stats?.autocorr[0] ?? 0);
  }
  return { windows, meanReverting: mr / windows, trending: tr / windows, none: (windows - mr - tr) / windows, meanStrength: strength / windows, ac1 };
}

/** Wilson score interval for a binomial proportion. */
export function wilson(hits: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = hits / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [centre - half, centre + half];
}
