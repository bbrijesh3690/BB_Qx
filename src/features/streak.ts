// Trailing run of same-coloured candles.

import type { Candle } from '../core/contracts';
import { colourOf, type Colour } from './candle-shape';

export interface Streak { colour: Colour; length: number }

/** Colour of the last candle and how many trailing candles share it. A flat last candle gives { 0, 0 }; a flat candle ends any streak. */
export function streak(candles: readonly Candle[]): Streak {
  if (candles.length === 0) return { colour: 0, length: 0 };
  const colour = colourOf(candles[candles.length - 1]!);
  if (colour === 0) return { colour: 0, length: 0 };
  let length = 0;
  for (let i = candles.length - 1; i >= 0 && colourOf(candles[i]!) === colour; i--) length++;
  return { colour, length };
}
