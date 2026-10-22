import { describe, expect, it } from 'vitest';
import type { MarketEvent } from '../core/contracts';
import { CandleBuilder } from '../core/candles';
import { normalCdf } from '../core/stats';
import { liveMarketOpen } from '../core/time';
import {
  bounded, DEFAULT_ASSETS, randomWalk, regimeSwitching, SYNTHETIC_START_TS, syntheticCandles, syntheticEvents, trending,
} from './generators';

const M = 60_000;
const ticksOf = (evs: MarketEvent[], asset: string) => evs.filter((e): e is Extract<MarketEvent, { kind: 'tick' }> => e.kind === 'tick' && e.asset === asset);

describe('synthetic generators', () => {
  it('are deterministic for a seed and differ across seeds', () => {
    const a = [...syntheticEvents(bounded(), 1, { candles: 50 })];
    const b = [...syntheticEvents(bounded(), 1, { candles: 50 })];
    const c = [...syntheticEvents(bounded(), 2, { candles: 50 })];
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });

  it('emit events in ts order, payouts first, from 2026-01-05 00:00 UTC', () => {
    const evs = [...syntheticEvents(randomWalk(), 3, { candles: 30 })];
    const ts = evs.map((e) => (e.kind === 'candle' ? 0 : e.ts));
    for (let i = 1; i < ts.length; i++) expect(ts[i]!).toBeGreaterThanOrEqual(ts[i - 1]!);
    expect(evs.slice(0, 4).map((e) => e.kind)).toEqual(['payout', 'payout', 'payout', 'payout']);
    expect(evs[0]).toEqual({ kind: 'payout', asset: 'EURUSD_otc', isOTC: true, ts: SYNTHETIC_START_TS, percent: 85 });
    expect(evs[2]).toMatchObject({ asset: 'EURUSD', isOTC: false, percent: 80 });
    expect(SYNTHETIC_START_TS).toBe(Date.parse('2026-01-05T00:00:00Z'));
    expect(evs.filter((e) => e.kind === 'tick')).toHaveLength(30 * 12 * DEFAULT_ASSETS.length);
  });

  it('first tick sits at openTs at the open, last tick before the boundary at the close; open = previous close', () => {
    const evs = [...syntheticEvents(randomWalk(), 4, { candles: 20, ticksPerCandle: 7 })];
    const ticks = ticksOf(evs, 'GBPUSD');
    for (let i = 0; i < 20; i++) {
      const c = ticks.slice(i * 7, i * 7 + 7);
      expect(c[0]!.ts).toBe(SYNTHETIC_START_TS + i * M);
      expect(c[6]!.ts).toBeLessThan(SYNTHETIC_START_TS + (i + 1) * M);
      if (i > 0) expect(c[0]!.price).toBe(ticks[i * 7 - 1]!.price);
    }
    expect(ticks.every((t) => Math.round(t.price * 1e5) / 1e5 === t.price)).toBe(true);
  });

  it('the candle builder rebuilds exactly the candles the generator describes', () => {
    const opts = { candles: 300 };
    const b = new CandleBuilder({ tf: '1m', historyCap: 1000 });
    for (const e of syntheticEvents(bounded(0.08), 5, opts)) if (e.kind === 'tick') b.onTick(e.asset, e.isOTC, e.ts, e.price);
    b.advance(SYNTHETIC_START_TS + 300 * M);
    for (const a of DEFAULT_ASSETS) expect(b.closed(a.asset)).toEqual(syntheticCandles(bounded(0.08), 5, a, opts));
  });

  it("one asset's prices do not depend on which other assets are present", () => {
    const solo = syntheticCandles(randomWalk(), 9, DEFAULT_ASSETS[2]!, { candles: 100 });
    const evs = [...syntheticEvents(randomWalk(), 9, { candles: 100 })];
    expect(ticksOf(evs, 'EURUSD').filter((_, i) => i % 12 === 11).map((t) => t.price)).toEqual(solo.map((c) => c.close));
  });

  it('with marketHours, live assets are silent while the live market is closed', () => {
    const candles = 7 * 24 * 60; // one week from Monday
    const evs = [...syntheticEvents(randomWalk(), 1, { candles, ticksPerCandle: 2, marketHours: true })];
    const live = ticksOf(evs, 'EURUSD'), otc = ticksOf(evs, 'EURUSD_otc');
    expect(otc).toHaveLength(candles * 2);
    expect(live.every((t) => liveMarketOpen(t.ts))).toBe(true);
    expect(live.length).toBeLessThan(otc.length);
    expect(live.length).toBe(otc.filter((t) => liveMarketOpen(Math.floor(t.ts / M) * M)).length);
  });

  it('emits scheduled payout changes at the start of their candle', () => {
    const evs = [...syntheticEvents(randomWalk(), 1, {
      candles: 10, assets: [{ asset: 'X_otc', isOTC: true, payout: [{ fromCandle: 4, percent: 92 }, { fromCandle: 0, percent: 80 }] }],
    })];
    const pays = evs.filter((e) => e.kind === 'payout');
    expect(pays.map((p) => (p.kind === 'payout' ? [p.ts, p.percent] : []))).toEqual([[SYNTHETIC_START_TS, 80], [SYNTHETIC_START_TS + 4 * M, 92]]);
    const idx = evs.findIndex((e) => e.kind === 'payout' && e.percent === 92);
    expect(evs[idx + 1]).toMatchObject({ kind: 'tick', ts: SYNTHETIC_START_TS + 4 * M });
  });

  it('trending: the share of up candles matches Phi(drift / sigma)', () => {
    const n = 100_000;
    const cs = syntheticCandles(trending(0.00003), 2, { asset: 'T', isOTC: true }, { candles: n, ticksPerCandle: 2, decimals: null, sigma: 0.0002 });
    const up = cs.filter((c) => c.close > c.open).length / n;
    const expected = normalCdf(0.15); // 0.5596
    expect(Math.abs(up - expected)).toBeLessThan(4.5 * Math.sqrt(0.25 / n));
  });

  it('bounded: price stays near its anchor with the stationary spread sigma / sqrt(1 - (1-k)^2)', () => {
    const k = 0.08, sigma = 0.0002, n = 100_000;
    const cs = syntheticCandles(bounded(k), 3, { asset: 'B', isOTC: true, startPrice: 1 }, { candles: n, ticksPerCandle: 2, decimals: null, sigma });
    const xs = cs.map((c) => Math.log(c.close));
    const sd = Math.sqrt(xs.reduce((s, x) => s + x * x, 0) / n);
    expect(sd / (sigma / Math.sqrt(1 - (1 - k) ** 2))).toBeGreaterThan(0.9);
    expect(sd / (sigma / Math.sqrt(1 - (1 - k) ** 2))).toBeLessThan(1.1);
  });

  it('regimeSwitching cycles random, bounded, trending and re-anchors at each segment', () => {
    const m = regimeSwitching({ segmentCandles: 5, k: 0.1, drift: 0.001 });
    expect([0, 4, 5, 9, 10, 14, 15].map((i) => m.regimeAt(i).kind)).toEqual(['random', 'random', 'bounded', 'bounded', 'trending', 'trending', 'random']);
    expect(m.regimeAt(6)).toEqual({ kind: 'bounded', drift: 0, k: 0.1 });
    expect(m.regimeAt(12)).toEqual({ kind: 'trending', drift: 0.001, k: 0 });
    expect([0, 1, 5, 10, 15, 16].map((i) => m.reanchorAt(i))).toEqual([true, false, true, true, true, false]);
    const v = regimeSwitching({ segmentCandles: [2, 3] });
    expect(Array.from({ length: 16 }, (_, i) => v.regimeAt(i).kind[0]).join('')).toBe('rrbbbttrrrbbtttr');
    expect(() => regimeSwitching({ segmentCandles: 0 })).toThrow();
  });

  it('generate 20,000 candles x 4 assets quickly', () => {
    let n = 0;
    for (const e of syntheticEvents(regimeSwitching(), 1, { candles: 20_000 })) if (e.kind === 'tick') n++;
    expect(n).toBe(20_000 * 12 * 4);
  });
});
