// RSI with Wilder smoothing. The one oscillator we keep; Stochastic, Williams %R and CCI carry the
// same range-position information (BB_Qx.md, Evidence) and are deliberately absent.

import type { Candle } from '../core/contracts';

/**
 * Wilder RSI over the whole series given: the first averages are plain means of the first `period`
 * gains and losses, then avg = (avg * (period - 1) + x) / period. Returns 50 for a flat series and
 * 100 when there are no losses. Null if there are fewer than period + 1 candles.
 */
export function rsi(candles: readonly Candle[], period = 14): number | null {
  if (!Number.isInteger(period) || period < 1) throw new RangeError(`period must be a positive integer, got ${period}`);
  if (candles.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i]!.close - candles[i - 1]!.close;
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i]!.close - candles[i - 1]!.close;
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}
