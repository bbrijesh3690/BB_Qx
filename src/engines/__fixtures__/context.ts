// Builds the Context the pipeline would hand an engine at the T-5s freeze.
// Closed candles end at index t; candle t + 1 is forming; the vote predicts candle t + 2, which
// opens at candleCloseAt. `forming` is left null on purpose: these engines must not read it,
// and a null makes any accidental dependence on the forming candle fail loudly in tests.

import { NEUTRAL_FEED, type Candle, type Context, type FeedStructure } from '../../core/contracts';

const MINUTE = 60_000;

/** `maxHistory` caps how many closed candles the context carries, like a bounded pipeline buffer. */
export function contextAt(
  candles: readonly Candle[], t: number, feed: FeedStructure = NEUTRAL_FEED, asset = 'FIXTURE_otc', maxHistory = Infinity,
): Context {
  const last = candles[t]!;
  const candleCloseAt = last.openTs + 2 * MINUTE;
  return {
    asset,
    isOTC: true,
    tf: '1m',
    candles: candles.slice(Math.max(0, t + 1 - maxHistory), t + 1),
    forming: null,
    ticks: [],
    now: candleCloseAt - 5_000,
    candleCloseAt,
    feed,
    payout: 0.85,
    session: { hourUtc: new Date(candleCloseAt).getUTCHours(), dayOfWeek: new Date(candleCloseAt).getUTCDay(), isOTC: true, marketOpen: true },
  };
}
