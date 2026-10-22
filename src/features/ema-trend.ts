// EMA 9/21 spread and slope in ATR units: the short-term drift family (MACD is the same thing
// and is deliberately absent).

import type { Candle } from '../core/contracts';
import { atr } from './atr';
import { closes, emaSeries } from './series';

export interface EmaTrendOptions { fast: number; slow: number; atrPeriod: number; slopeLag: number }
export const DEFAULT_EMA_TREND: EmaTrendOptions = { fast: 9, slow: 21, atrPeriod: 14, slopeLag: 3 };

export interface EmaTrend {
  /** (EMA fast - EMA slow) / ATR. */
  spread: number;
  /** Per-candle change of the fast EMA over the last slopeLag candles, / ATR. */
  fastSlope: number;
  /** Per-candle change of the slow EMA over the last slopeLag candles, / ATR. */
  slowSlope: number;
  atr: number;
}

/** Null until both EMAs have slopeLag + 1 values and ATR exists, or if ATR is zero. */
export function emaTrend(candles: readonly Candle[], opts: EmaTrendOptions = DEFAULT_EMA_TREND): EmaTrend | null {
  const cs = closes(candles);
  const fast = emaSeries(cs, opts.fast);
  const slow = emaSeries(cs, opts.slow);
  const a = atr(candles, opts.atrPeriod);
  const lag = opts.slopeLag;
  if (a === null || a <= 0 || fast.length < lag + 1 || slow.length < lag + 1) return null;
  const f = fast[fast.length - 1]!;
  const s = slow[slow.length - 1]!;
  return {
    spread: (f - s) / a,
    fastSlope: (f - fast[fast.length - 1 - lag]!) / (lag * a),
    slowSlope: (s - slow[slow.length - 1 - lag]!) / (lag * a),
    atr: a,
  };
}
