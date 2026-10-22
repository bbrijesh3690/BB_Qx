import { describe, expect, it } from 'vitest';
import { hashSeed, mulberry32, Rng } from './rng';

describe('rng', () => {
  it('is deterministic for a seed and differs across seeds', () => {
    const a = new Rng(42), b = new Rng(42), c = new Rng(43);
    const xs = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(xs);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(xs);
  });

  it('matches mulberry32 and stays in [0, 1)', () => {
    const r = new Rng(7), m = mulberry32(7);
    for (let i = 0; i < 10_000; i++) {
      const x = r.next();
      expect(x).toBe(m());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('draws uniform and normal values with the right moments', () => {
    const r = new Rng(1);
    const n = 200_000;
    let su = 0, sn = 0, sn2 = 0;
    for (let i = 0; i < n; i++) {
      su += r.uniform(2, 4);
      const z = r.normal(1, 2);
      sn += z; sn2 += z * z;
    }
    const mu = sn / n;
    expect(su / n).toBeCloseTo(3, 2);
    expect(mu).toBeCloseTo(1, 1);
    expect(Math.sqrt(sn2 / n - mu * mu)).toBeCloseTo(2, 1);
  });

  it('int draws cover [0, n)', () => {
    const r = new Rng(3);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) seen.add(r.int(6));
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('snapshots and restores mid-stream, including the Box-Muller spare', () => {
    const r = new Rng(9);
    r.normal();
    const snap = r.snapshot();
    const expected = [r.normal(), r.next(), r.normal()];
    const s = Rng.fromSnapshot(snap);
    expect([s.normal(), s.next(), s.normal()]).toEqual(expected);
  });

  it('hashSeed is stable, typed and order-sensitive', () => {
    expect(hashSeed(1, 'EURUSD_otc', '1m', 1767571260000)).toBe(hashSeed(1, 'EURUSD_otc', '1m', 1767571260000));
    expect(hashSeed(1)).not.toBe(hashSeed('1'));
    expect(hashSeed('ab', 'c')).not.toBe(hashSeed('a', 'bc'));
    expect(hashSeed(1, 2)).not.toBe(hashSeed(2, 1));
    // Pinned so a silent change to the hash (which would change every recorded null vote) fails loudly.
    expect(hashSeed('bbqx')).toBe(PINNED_BBQX);
    expect(hashSeed(1, 'EURUSD_otc', '1m', 1767571260000)).toBe(PINNED_VOTE);
  });

  it('hashSeed spreads consecutive inputs evenly', () => {
    let ones = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) if (hashSeed(5, 'X', i) >>> 31) ones++;
    expect(Math.abs(ones / n - 0.5)).toBeLessThan(0.02);
  });
});

const PINNED_BBQX = 4034603050;
const PINNED_VOTE = 3285240301;
