// Average true range (Wilder). Volatility family: used to normalise other features, never to vote.

import type { Candle } from '../core/contracts';

export function trueRange(c: Candle, prevClose: number): number {
  return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
}

/**
 * Wilder ATR: the first value is the mean of the first `period` true ranges, then
 * atr = (atr * (period - 1) + tr) / period. True range needs the previous close, so the
 * first candle only supplies a close; null if there are fewer than period + 1 candles.
 */
export function atr(candles: readonly Candle[], period = 14): number | null {
  if (!Number.isInteger(period) || period < 1) throw new RangeError(`period must be a positive integer, got ${period}`);
  if (candles.length < period + 1) return null;
  let value = 0;
  for (let i = 1; i <= period; i++) value += trueRange(candles[i]!, candles[i - 1]!.close);
  value /= period;
  for (let i = period + 1; i < candles.length; i++) {
    value = (value * (period - 1) + trueRange(candles[i]!, candles[i - 1]!.close)) / period;
  }
  return value;
}
