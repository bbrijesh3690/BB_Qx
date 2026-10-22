// Moving averages and dispersion over plain number series (oldest first).
// Every function looks only at the values it is given, so callers control the lookback.

import type { Candle } from '../core/contracts';

function assertPeriod(period: number): void {
  if (!Number.isInteger(period) || period < 1) throw new RangeError(`period must be a positive integer, got ${period}`);
}

export function closes(candles: readonly Candle[]): number[] {
  return candles.map((c) => c.close);
}

/** Simple moving average of the last `period` values; null if there are fewer. */
export function sma(values: readonly number[], period: number): number | null {
  assertPeriod(period);
  if (values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i]!;
  return sum / period;
}

/**
 * EMA series with alpha = 2 / (period + 1), seeded with the SMA of the first `period` values.
 * out[i] belongs to values[i + period - 1]; the result is empty if there are fewer than `period` values.
 */
export function emaSeries(values: readonly number[], period: number): number[] {
  assertPeriod(period);
  if (values.length < period) return [];
  const alpha = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i]!;
  prev /= period;
  const out = [prev];
  for (let i = period; i < values.length; i++) {
    prev = alpha * values[i]! + (1 - alpha) * prev;
    out.push(prev);
  }
  return out;
}

/** Last value of emaSeries; null if there are fewer than `period` values. */
export function ema(values: readonly number[], period: number): number | null {
  const s = emaSeries(values, period);
  return s.length === 0 ? null : s[s.length - 1]!;
}

/** Population standard deviation (divide by N, as Bollinger uses) of the last `period` values. */
export function stdev(values: readonly number[], period: number): number | null {
  const mean = sma(values, period);
  if (mean === null) return null;
  let ss = 0;
  for (let i = values.length - period; i < values.length; i++) ss += (values[i]! - mean) ** 2;
  return Math.sqrt(ss / period);
}
