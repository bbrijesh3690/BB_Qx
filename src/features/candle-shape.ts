// Shape of a single candle: colour, body and wick proportions.

import type { Candle } from '../core/contracts';

export type Colour = 1 | -1 | 0;

/** 1 green (close > open), -1 red, 0 flat. */
export function colourOf(c: Candle): Colour {
  return c.close > c.open ? 1 : c.close < c.open ? -1 : 0;
}

// A doji's wick-to-body ratio is unbounded and says no more beyond this; the cap keeps features finite.
export const WICK_RATIO_CAP = 10; // TUNABLE: ratios above 10 carry no extra information and must stay JSON-safe

export interface CandleShape {
  body: number;
  upperWick: number;
  lowerWick: number;
  range: number;
  /** body / range, 0 if range is 0. bodyFrac + upperFrac + lowerFrac = 1 when range > 0. */
  bodyFrac: number;
  upperFrac: number;
  lowerFrac: number;
  /** wick / body, capped at WICK_RATIO_CAP (also when the body is 0 and the wick is not). */
  upperToBody: number;
  lowerToBody: number;
}

function ratio(wick: number, body: number): number {
  if (wick <= 0) return 0;
  if (body <= 0) return WICK_RATIO_CAP;
  return Math.min(wick / body, WICK_RATIO_CAP);
}

export function candleShape(c: Candle): CandleShape {
  const top = Math.max(c.open, c.close);
  const bottom = Math.min(c.open, c.close);
  const body = top - bottom;
  const upperWick = Math.max(0, c.high - top);
  const lowerWick = Math.max(0, bottom - c.low);
  const range = c.high - c.low;
  const frac = (x: number): number => (range > 0 ? x / range : 0);
  return {
    body, upperWick, lowerWick, range,
    bodyFrac: frac(body), upperFrac: frac(upperWick), lowerFrac: frac(lowerWick),
    upperToBody: ratio(upperWick, body), lowerToBody: ratio(lowerWick, body),
  };
}
