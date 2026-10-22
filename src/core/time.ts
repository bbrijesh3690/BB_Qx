// Server-time helpers. Candle boundaries are server time modulo the timeframe.

import { TF_MS, type SessionInfo, type Timeframe } from './contracts';
import { TUNABLES } from './tunables';

/** Open time of the candle containing `ts`. A tick at exactly openTs belongs to that candle. */
export function openTsOf(ts: number, tf: Timeframe): number {
  const ms = TF_MS[tf];
  return Math.floor(ts / ms) * ms;
}

/** Close time of the candle containing `ts` (= open time of the next candle). */
export function closeTsOf(ts: number, tf: Timeframe): number {
  return openTsOf(ts, tf) + TF_MS[tf];
}

const FRIDAY = 5;
const SATURDAY = 6;
const SUNDAY = 0;

/** Live forex is closed from Friday close to Sunday open, UTC. */
export function liveMarketOpen(ts: number): boolean {
  const d = new Date(ts);
  const day = d.getUTCDay();
  const hour = d.getUTCHours();
  if (day === SATURDAY) return false;
  if (day === FRIDAY && hour >= TUNABLES.liveCloseFridayHourUtc.value) return false; // TUNABLE: liveCloseFridayHourUtc
  if (day === SUNDAY && hour < TUNABLES.liveOpenSundayHourUtc.value) return false; // TUNABLE: liveOpenSundayHourUtc
  return true;
}

/** Session of a server timestamp. OTC assets never close. */
export function sessionOf(ts: number, isOTC: boolean): SessionInfo {
  const d = new Date(ts);
  return {
    hourUtc: d.getUTCHours(),
    dayOfWeek: d.getUTCDay(),
    isOTC,
    marketOpen: isOTC || liveMarketOpen(ts),
  };
}

/** UTC calendar day of a timestamp as 'YYYY-MM-DD'. */
export function utcDayOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}
