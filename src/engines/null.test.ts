import { describe, expect, it } from 'vitest';
import { NEUTRAL_FEED, type Context, type Outcome, type Vote } from '../core/contracts';
import { Rng } from '../core/rng';
import { sessionOf } from '../core/time';
import { nullEngine } from './null';

const T = Date.UTC(2026, 0, 5, 10, 0);
const M = 60_000;

function ctx(asset: string, closeAt: number, extra: Partial<Context> = {}): Context {
  return {
    asset, isOTC: asset.endsWith('_otc'), tf: '1m', candles: [], forming: null, ticks: [], now: closeAt - 5000,
    candleCloseAt: closeAt, feed: NEUTRAL_FEED, payout: 0.85, session: sessionOf(closeAt, true), ...extra,
  };
}

const up = (): Vote => ({ engine: 'null', direction: 'UP', confidence: 0.5, reasons: ['coin flip'] });

describe('null engine', () => {
  it('is a baseline with no warmup', () => {
    const e = nullEngine(1);
    expect(e).toMatchObject({ id: 'null', kind: 'baseline', warmupCandles: 0 });
  });

  it('votes UP or DOWN at confidence 0.5 from (seed, asset, tf, candleCloseAt) only', () => {
    const a = nullEngine(7), b = nullEngine(7), c = nullEngine(8);
    const c0 = ctx('EURUSD_otc', T + M);
    const v = a.vote(c0);
    expect(v).toMatchObject({ engine: 'null', confidence: 0.5, reasons: ['coin flip'] });
    expect(['UP', 'DOWN']).toContain(v.direction);
    // Pure: other context fields and earlier calls change nothing.
    const busy = ctx('EURUSD_otc', T + M, { candles: [{ openTs: T, open: 1, high: 2, low: 0.5, close: 1.5, tickCount: 3 }], payout: 0.9 });
    expect(a.vote(busy)).toEqual(v);
    expect(b.vote(c0)).toEqual(v);
    let differ = 0;
    for (let i = 0; i < 200; i++) {
      const k = ctx('EURUSD_otc', T + i * M);
      if (a.vote(k).direction !== c.vote(k).direction) differ++;
    }
    expect(differ).toBeGreaterThan(60);
    expect(differ).toBeLessThan(140);
  });

  it('is balanced and independent across consecutive candles and assets', () => {
    const e = nullEngine(3);
    const n = 20_000;
    let ups = 0, same = 0, prev = '';
    for (let i = 0; i < n; i++) {
      const d = e.vote(ctx(i % 2 ? 'EURUSD' : 'EURUSD_otc', T + Math.floor(i / 2) * M)).direction;
      if (d === 'UP') ups++;
      if (d === prev) same++;
      prev = d;
    }
    // 4.5 sigma bands: sd = 0.5 / sqrt(n) = 0.0035
    expect(Math.abs(ups / n - 0.5)).toBeLessThan(0.016);
    expect(Math.abs(same / (n - 1) - 0.5)).toBeLessThan(0.016);
  });

  it('keeps per-asset counters, excludes ties from accuracy, and reports windows only once full', () => {
    const e = nullEngine(1);
    const k = ctx('A_otc', T);
    expect(e.stats('A_otc')).toEqual({ votes: 0, abstains: 0, hits: 0, ties: 0, last100: null, last200: null, brier: null, killed: false });
    const rng = new Rng(5);
    const results: Outcome[] = [];
    for (let i = 0; i < 260; i++) results.push(i % 13 === 0 ? 'TIE' : rng.next() < 0.5 ? 'WIN' : 'LOSS');
    results.slice(0, 120).forEach((r) => e.onOutcome(up(), r, k));
    e.onOutcome({ engine: 'null', direction: 'ABSTAIN', confidence: 0.5, reasons: [] }, 'WIN', k);
    const nonTie120 = results.slice(0, 120).filter((r) => r !== 'TIE');
    let s = e.stats('A_otc');
    expect(s.votes).toBe(120);
    expect(s.abstains).toBe(1);
    expect(s.ties).toBe(120 - nonTie120.length);
    expect(s.hits).toBe(nonTie120.filter((r) => r === 'WIN').length);
    expect(s.last100).toBeCloseTo(nonTie120.slice(-100).filter((r) => r === 'WIN').length / 100, 12);
    expect(s.last200).toBeNull();
    expect(s.brier).toBeCloseTo(0.25, 12);
    results.slice(120).forEach((r) => e.onOutcome(up(), r, k));
    const nonTie = results.filter((r) => r !== 'TIE');
    s = e.stats('A_otc');
    expect(s.last200).toBeCloseTo(nonTie.slice(-200).filter((r) => r === 'WIN').length / 200, 12);
    expect(s.last100).toBeCloseTo(nonTie.slice(-100).filter((r) => r === 'WIN').length / 100, 12);
    expect(e.stats('B').votes).toBe(0);
  });

  it('brier uses the confidence of the voted side', () => {
    const e = nullEngine(1);
    const k = ctx('A_otc', T);
    e.onOutcome({ ...up(), confidence: 0.8 }, 'WIN', k);   // (0.8 - 1)^2 = 0.04
    e.onOutcome({ ...up(), confidence: 0.8 }, 'LOSS', k);  // (0.8 - 0)^2 = 0.64
    e.onOutcome({ ...up(), confidence: 0.8 }, 'TIE', k);   // excluded
    expect(e.stats('A_otc').brier).toBeCloseTo(0.34, 12);
  });

  it('serialize and restore round-trip, and restored engines carry on identically', () => {
    const a = nullEngine(2);
    const rng = new Rng(9);
    const feed = (e: ReturnType<typeof nullEngine>, n: number, asset: string) => {
      for (let i = 0; i < n; i++) e.onOutcome(up(), rng.next() < 0.03 ? 'TIE' : rng.next() < 0.5 ? 'WIN' : 'LOSS', ctx(asset, T));
    };
    feed(a, 450, 'A_otc');
    feed(a, 30, 'B');
    const state = JSON.parse(JSON.stringify(a.serialize()));
    const b = nullEngine(2);
    b.restore(state);
    expect(b.serialize()).toEqual(a.serialize());
    for (const asset of ['A_otc', 'B', 'C']) expect(b.stats(asset)).toEqual(a.stats(asset));
    const r1 = new Rng(4), r2 = new Rng(4);
    for (let i = 0; i < 150; i++) {
      a.onOutcome(up(), r1.next() < 0.5 ? 'WIN' : 'LOSS', ctx('A_otc', T));
      b.onOutcome(up(), r2.next() < 0.5 ? 'WIN' : 'LOSS', ctx('A_otc', T));
    }
    expect(b.serialize()).toEqual(a.serialize());
    expect(JSON.stringify(a.serialize()).length).toBeLessThan(2000);
  });

  it('restore rejects states that are not its own', () => {
    const e = nullEngine(1);
    expect(() => e.restore(null)).toThrow();
    expect(() => e.restore({ engine: 'other', version: 1, assets: {} })).toThrow();
    expect(() => e.restore({ engine: 'null', version: 1, assets: { A: { votes: -1 } } })).toThrow();
    e.restore({ engine: 'null', version: 1, assets: {} });
    expect(e.stats('A').votes).toBe(0);
  });
});
