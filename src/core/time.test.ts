import { describe, expect, it } from 'vitest';
import { closeTsOf, liveMarketOpen, openTsOf, sessionOf, utcDayOf } from './time';

const MON = Date.UTC(2026, 0, 5); // Monday 2026-01-05 00:00 UTC
const at = (day: number, hour: number, minute = 0) => Date.UTC(2026, 0, day, hour, minute);

describe('time', () => {
  it('candle boundaries are server time modulo tf; a tick at openTs opens the new candle', () => {
    expect(openTsOf(MON, '1m')).toBe(MON);
    expect(openTsOf(MON + 59_999, '1m')).toBe(MON);
    expect(openTsOf(MON + 60_000, '1m')).toBe(MON + 60_000);
    expect(openTsOf(MON + 119_999, '2m')).toBe(MON);
    expect(openTsOf(MON + 299_999, '5m')).toBe(MON);
    expect(closeTsOf(MON + 1, '1m')).toBe(MON + 60_000);
    expect(closeTsOf(MON, '5m')).toBe(MON + 300_000);
  });

  it('live forex closes Friday 21:00 UTC and reopens Sunday 21:00 UTC', () => {
    expect(liveMarketOpen(at(9, 20, 59))).toBe(true);   // Friday
    expect(liveMarketOpen(at(9, 21, 0))).toBe(false);
    expect(liveMarketOpen(at(10, 12))).toBe(false);     // Saturday
    expect(liveMarketOpen(at(11, 20, 59))).toBe(false); // Sunday
    expect(liveMarketOpen(at(11, 21, 0))).toBe(true);
    expect(liveMarketOpen(at(7, 3))).toBe(true);        // Wednesday
  });

  it('sessionOf reports hour, weekday and market state; OTC is always open', () => {
    expect(sessionOf(at(10, 13, 30), false)).toEqual({ hourUtc: 13, dayOfWeek: 6, isOTC: false, marketOpen: false });
    expect(sessionOf(at(10, 13, 30), true)).toEqual({ hourUtc: 13, dayOfWeek: 6, isOTC: true, marketOpen: true });
    expect(sessionOf(MON, false)).toEqual({ hourUtc: 0, dayOfWeek: 1, isOTC: false, marketOpen: true });
  });

  it('utcDayOf gives the calendar day', () => {
    expect(utcDayOf(MON + 86_399_999)).toBe('2026-01-05');
    expect(utcDayOf(MON + 86_400_000)).toBe('2026-01-06');
  });
});
