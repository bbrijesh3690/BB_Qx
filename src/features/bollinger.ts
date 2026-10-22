// Bollinger bands and %B: the range-position family (RSI is the other member we keep).

import type { Candle } from '../core/contracts';
import { closes, sma, stdev } from './series';

export interface Bollinger {
  middle: number;
  upper: number;
  lower: number;
  /** (close - lower) / (upper - lower): 0 at the lower band, 1 at the upper band, 0.5 if the bands collapse. */
  percentB: number;
  /** (upper - lower) / middle. */
  bandwidth: number;
}

export function bollinger(candles: readonly Candle[], period = 20, mult = 2): Bollinger | null {
  const cs = closes(candles);
  const middle = sma(cs, period);
  const sd = stdev(cs, period);
  if (middle === null || sd === null) return null;
  const upper = middle + mult * sd;
  const lower = middle - mult * sd;
  const last = cs[cs.length - 1]!;
  const width = upper - lower;
  return {
    middle,
    upper,
    lower,
    percentB: width > 0 ? (last - lower) / width : 0.5,
    bandwidth: middle !== 0 ? width / middle : 0,
  };
}
