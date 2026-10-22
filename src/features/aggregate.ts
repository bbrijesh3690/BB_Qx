// Higher-timeframe candles from base candles, on server-time boundaries (openTs modulo the target).

import type { Candle } from '../core/contracts';

export const MINUTE_MS = 60_000;

/**
 * Aggregates base candles (oldest first, each openTs a multiple of baseMs) into targetMs candles.
 * A bucket is kept only when every one of its targetMs / baseMs slots is present exactly once,
 * so leading, trailing (still forming) and gapped buckets are all excluded.
 */
export function aggregate(candles: readonly Candle[], baseMs: number, targetMs: number): Candle[] {
  if (!(baseMs > 0) || !(targetMs > 0) || targetMs % baseMs !== 0) {
    throw new RangeError(`targetMs (${targetMs}) must be a positive multiple of baseMs (${baseMs})`);
  }
  const slots = targetMs / baseMs;
  const out: Candle[] = [];
  let i = 0;
  while (i < candles.length) {
    const start = candles[i]!.openTs - (((candles[i]!.openTs % targetMs) + targetMs) % targetMs);
    let j = i;
    let complete = true;
    while (j < candles.length && candles[j]!.openTs < start + targetMs) {
      if (candles[j]!.openTs !== start + (j - i) * baseMs) complete = false;
      j++;
    }
    if (complete && j - i === slots) {
      const bucket = candles.slice(i, j);
      out.push({
        openTs: start,
        open: bucket[0]!.open,
        high: Math.max(...bucket.map((c) => c.high)),
        low: Math.min(...bucket.map((c) => c.low)),
        close: bucket[bucket.length - 1]!.close,
        tickCount: bucket.reduce((s, c) => s + c.tickCount, 0),
      });
    }
    i = j;
  }
  return out;
}
