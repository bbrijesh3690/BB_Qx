import { describe, expect, it } from 'vitest';
import type { ScoredVote, VoteRecord } from './contracts';
import {
  autocorr, binomialTestGreater, binomialUpperTail, criticalCountOneSided, exactPowerOneSided, lnGamma,
  normalCdf, normalInv, pearson, sampleSizeOneSided, summarizeVotes, wilson,
} from './stats';

/** Brute-force binomial upper tail for small n. */
function bruteUpper(k: number, n: number, p: number): number {
  let s = 0;
  for (let j = k; j <= n; j++) {
    let c = 1;
    for (let i = 0; i < j; i++) c = (c * (n - i)) / (i + 1);
    s += c * p ** j * (1 - p) ** (n - j);
  }
  return s;
}

describe('stats', () => {
  it('Wilson interval matches known values', () => {
    const w = wilson(50, 100);
    expect(w.lo).toBeCloseTo(0.4038, 4);
    expect(w.hi).toBeCloseTo(0.5962, 4);
    const z = wilson(0, 10);
    expect(z.lo).toBe(0);
    expect(z.hi).toBeCloseTo(0.2775, 4);
    expect(wilson(0, 0)).toEqual({ lo: 0, hi: 1 });
  });

  it('lnGamma is accurate', () => {
    expect(lnGamma(1)).toBeCloseTo(0, 12);
    expect(lnGamma(11)).toBeCloseTo(Math.log(3628800), 10);
    expect(lnGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 12);
  });

  it('binomial tails match brute force on both sides of the mean', () => {
    for (const [k, n, p] of [[0, 20, 0.5], [3, 20, 0.5], [10, 20, 0.5], [15, 20, 0.5], [20, 20, 0.5], [7, 30, 0.3], [25, 30, 0.6]] as const) {
      expect(binomialUpperTail(k, n, p)).toBeCloseTo(bruteUpper(k, n, p), 12);
    }
    expect(binomialUpperTail(21, 20, 0.5)).toBe(0);
    expect(binomialTestGreater(60, 100)).toBeCloseTo(0.028444, 5);
    // Large n stays finite and sensible.
    expect(binomialTestGreater(50_000, 100_000)).toBeCloseTo(0.50126, 4);
    expect(binomialTestGreater(51_000, 100_000)).toBeLessThan(1e-9);
  });

  it('normal CDF and inverse agree', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.959963984540054)).toBeCloseTo(0.975, 6);
    expect(normalInv(0.975)).toBeCloseTo(1.959964, 6);
    expect(normalInv(0.05)).toBeCloseTo(-1.644854, 6);
    for (const p of [0.001, 0.01, 0.2, 0.5, 0.8, 0.99, 0.999]) expect(normalCdf(normalInv(p))).toBeCloseTo(p, 6);
  });

  it('power helpers', () => {
    expect(sampleSizeOneSided(0.5, 0.55, 0.05, 0.8)).toBe(617);
    const n = 600;
    const k = criticalCountOneSided(n, 0.5, 0.05);
    expect(binomialUpperTail(k, n, 0.5)).toBeLessThanOrEqual(0.05);
    expect(binomialUpperTail(k - 1, n, 0.5)).toBeGreaterThan(0.05);
    const power = exactPowerOneSided(n, 0.5, 0.55, 0.05);
    expect(power).toBeGreaterThan(0.75);
    expect(power).toBeLessThan(0.85);
  });

  it('pearson and autocorr', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 12);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 12);
    expect(autocorr([1, -1, 1, -1, 1, -1, 1, -1], 1)).toBeCloseTo(-0.875, 12);
  });

  it('summarizeVotes counts abstains, ties and accuracy with n', () => {
    let id = 0;
    const v = (direction: VoteRecord['direction']): VoteRecord => ({
      voteId: String(id++), ts: 0, asset: 'A', isOTC: true, tf: '1m', candleOpenTs: 0, bucket: 0,
      engine: 'e', direction, confidence: 0.5, reasons: [], payoutAtVote: 0.8, frozenAt: 0,
    });
    const o = (result: 'WIN' | 'LOSS' | 'TIE') => ({ voteId: 'x', result, openPrice: 1, closePrice: 1, scoredAt: 0 });
    const rows: ScoredVote[] = [
      { vote: v('UP'), outcome: o('WIN') }, { vote: v('DOWN'), outcome: o('LOSS') }, { vote: v('UP'), outcome: o('TIE') },
      { vote: v('UP'), outcome: o('WIN') }, { vote: v('ABSTAIN'), outcome: null }, { vote: v('DOWN'), outcome: null },
    ];
    const s = summarizeVotes(rows);
    expect(s).toMatchObject({ votes: 6, abstains: 1, directional: 5, scored: 4, ties: 1, hits: 2, losses: 1, n: 3 });
    expect(s.accuracy).toBeCloseTo(2 / 3, 12);
    expect(summarizeVotes([]).accuracy).toBeNull();
  });
});
