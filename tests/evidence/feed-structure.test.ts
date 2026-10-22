// BB_Qx.md Evidence 3: a pure random walk has no lag-1 autocorrelation and fades a 3-streak half the
// time; the bounded generator (k = 0.08) has autocorrelation about -k/2 = -0.04 and fades about 53-54%.
// Brief (smaller sample): random -0.004 / 49.8%, bounded -0.038 / 53.3%. A 2,000,000-candle reference
// run of this generator gives bounded -0.041 / 53.7%.

import { describe, expect, it } from 'vitest';
import { autocorr } from '../../src/core/stats';
import { bounded, randomWalk, syntheticCandles, type PriceModel } from '../../src/harness/generators';

const N = 200_000; // SE of autocorr about 1/sqrt(N) = 0.0022; about 47,000 streaks, SE of fade about 0.0023

function structure(model: PriceModel, seed: number) {
  const cs = syntheticCandles(model, seed, { asset: 'X_otc', isOTC: true }, { candles: N, ticksPerCandle: 2, decimals: null });
  const r = cs.map((c) => Math.log(c.close / c.open));
  let streaks = 0, fades = 0;
  for (let i = 3; i < r.length; i++) {
    const a = Math.sign(r[i - 1]!);
    if (a !== 0 && a === Math.sign(r[i - 2]!) && a === Math.sign(r[i - 3]!)) {
      streaks++;
      if (Math.sign(r[i]!) === -a) fades++;
    }
  }
  return { ac1: autocorr(r, 1), fade: fades / streaks, streaks };
}

describe('evidence: synthetic feed structure', () => {
  it('random walk: lag-1 autocorrelation about 0, fade-after-3 about 50%', () => {
    const s = structure(randomWalk(), 1);
    console.info(`random walk (n = ${N}): ac1 ${s.ac1.toFixed(4)}, fade-after-3 ${(100 * s.fade).toFixed(2)}% over ${s.streaks} streaks`);
    expect(Math.abs(s.ac1)).toBeLessThan(0.01);
    expect(Math.abs(s.fade - 0.5)).toBeLessThan(0.01);
  });

  it('bounded k = 0.08: lag-1 autocorrelation about -0.04, fade-after-3 about 53-54%', () => {
    const s = structure(bounded(0.08), 1);
    console.info(`bounded k=0.08 (n = ${N}): ac1 ${s.ac1.toFixed(4)}, fade-after-3 ${(100 * s.fade).toFixed(2)}% over ${s.streaks} streaks`);
    expect(Math.abs(s.ac1 - -0.04)).toBeLessThan(0.01);
    expect(s.fade).toBeGreaterThan(0.525);
    expect(s.fade).toBeLessThan(0.55);
  });
});
