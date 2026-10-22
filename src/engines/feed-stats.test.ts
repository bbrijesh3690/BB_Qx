import { describe, expect, it } from 'vitest';
import { autocorrelations, driftZ, normalTail, runsZ, streakReversal, varianceRatio } from './feed-stats';

describe('feed statistics, hand-computed', () => {
  it('autocorrelation of an alternating series', () => {
    // mean 0, sum of squares 6; lag 1: five products of -1; lag 2: four products of +1
    const ac = autocorrelations([1, -1, 1, -1, 1, -1], 2);
    expect(ac[0]).toBeCloseTo(-5 / 6, 12);
    expect(ac[1]).toBeCloseTo(4 / 6, 12);
    expect(autocorrelations([2, 2, 2], 1)).toEqual([0]);
  });

  it('Lo-MacKinlay variance ratio and robust z* on a five-return series', () => {
    // r = 1 2 0 1 3: mu 1.4, deviations^2 .16 .36 1.96 .16 2.56 (sum 5.2), var_a 5.2 / 4
    // 2-period sums minus 2 mu: .2 -.8 -1.8 1.2, squares sum 5.36, m = 2 * 4 * (1 - 2/5) = 4.8
    // delta(1) = 5 * (.0576 + .7056 + .3136 + .4096) / 5.2^2, theta = delta(1)
    const { vr, z } = varianceRatio([1, 2, 0, 1, 3], 2);
    const expectedVr = 5.36 / 4.8 / (5.2 / 4);
    const theta = (5 * 1.4864) / (5.2 * 5.2);
    expect(vr).toBeCloseTo(expectedVr, 12);
    expect(z).toBeCloseTo((expectedVr - 1) * Math.sqrt(5 / theta), 10);
  });

  it('variance ratio edge cases', () => {
    expect(varianceRatio(Array.from({ length: 100 }, (_, i) => (i % 2 ? -1 : 1)), 2).vr).toBeCloseTo(0, 12);
    expect(varianceRatio([1, 1, 1, 1, 1], 2)).toEqual({ vr: 1, z: 0 });
    expect(varianceRatio([1, 2, 3], 2)).toEqual({ vr: 1, z: 0 });
  });

  it('runs test z', () => {
    // n1 6, n2 4, runs 5: E = 2*6*4/10 + 1 = 5.8, Var = 2*24*(48 - 10) / (100 * 9)
    expect(runsZ([1, 1, -1, -1, 1, 1, -1, -1, 1, 1])).toBeCloseTo((5 - 5.8) / Math.sqrt((48 * 38) / 900), 12);
    expect(runsZ([1, 0, 1, 0, -1])).toBe(runsZ([1, 1, -1])); // flats dropped
    expect(runsZ([1, 1, 1])).toBe(0);
  });

  it('streak reversal rate after runs of 3 or more', () => {
    // events at t = 3 (rev), 7 (cont), 8 (rev), 11 (cont), 12 (rev): 3 of 5
    const s = streakReversal([1, 1, 1, -1, 1, 1, 1, 1, -1, -1, -1, -1, 1], 3);
    expect(s.events).toBe(5);
    expect(s.rate).toBeCloseTo(0.6, 12);
    expect(s.z).toBeCloseTo(0.1 / Math.sqrt(0.25 / 5), 12);
    expect(streakReversal([1, 1, 1, 0, -1], 3)).toEqual({ rate: 0.5, events: 0, z: 0 }); // a flat candle is no outcome and ends the run
  });

  it('drift t statistic', () => {
    expect(driftZ([1, 2, 3])).toBeCloseTo(2 / (1 / Math.sqrt(3)), 12);
    expect(driftZ([1, 1, 1])).toBe(0);
  });

  it('normal tail', () => {
    expect(normalTail(0)).toBeCloseTo(0.5, 7);
    expect(normalTail(1.959964)).toBeCloseTo(0.025, 6);
    expect(normalTail(-1)).toBeCloseTo(0.841345, 6);
    expect(normalTail(3)).toBeCloseTo(0.0013499, 6);
  });
});
