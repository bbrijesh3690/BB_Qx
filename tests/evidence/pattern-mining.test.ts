// BB_Qx.md Evidence 1: mining colour sequences on coin-flip candles finds "patterns" in-sample
// that are worth nothing out-of-sample. Brief: 27 patterns at >= 58% in-sample, 49.9% out-of-sample.

import { describe, expect, it } from 'vitest';
import { randomWalk, syntheticCandles } from '../../src/harness/generators';

interface Count { up: number; n: number }

function countSequences(colours: readonly number[], from: number, to: number, len: number): Map<string, Count> {
  const m = new Map<string, Count>();
  for (let i = Math.max(from, len); i < to; i++) {
    const key = colours.slice(i - len, i).join('');
    let c = m.get(key);
    if (!c) m.set(key, (c = { up: 0, n: 0 }));
    c.n++;
    c.up += colours[i]!;
  }
  return m;
}

describe('evidence: pattern mining on noise', () => {
  it('patterns found at >= 58% in-sample average about 50% out-of-sample', () => {
    const candles = syntheticCandles(randomWalk(), 2026, { asset: 'X_otc', isOTC: true }, { candles: 20_000, ticksPerCandle: 2, decimals: null });
    const colours = candles.map((c) => (c.close > c.open ? 1 : 0)); // no ties without rounding
    const half = colours.length / 2;
    const found: { key: string; inAcc: number; outAcc: number; outN: number }[] = [];
    for (let len = 2; len <= 7; len++) {
      const inS = countSequences(colours, 0, half, len);
      const outS = countSequences(colours, half, colours.length, len);
      for (const [key, c] of inS) {
        if (c.n < 30) continue;
        const upAcc = c.up / c.n;
        const inAcc = Math.max(upAcc, 1 - upAcc);
        if (inAcc < 0.58) continue;
        const o = outS.get(key);
        if (!o) continue;
        const outAcc = upAcc >= 0.5 ? o.up / o.n : 1 - o.up / o.n;
        found.push({ key, inAcc, outAcc, outN: o.n });
      }
    }
    const meanIn = found.reduce((s, p) => s + p.inAcc, 0) / found.length;
    const meanOut = found.reduce((s, p) => s + p.outAcc, 0) / found.length;
    const pooledOut = found.reduce((s, p) => s + p.outAcc * p.outN, 0) / found.reduce((s, p) => s + p.outN, 0);
    console.info(`pattern mining: ${found.length} patterns >= 58% in-sample (mean ${(100 * meanIn).toFixed(1)}%), ` +
      `out-of-sample mean ${(100 * meanOut).toFixed(1)}% (range ${(100 * Math.min(...found.map((p) => p.outAcc))).toFixed(0)}-` +
      `${(100 * Math.max(...found.map((p) => p.outAcc))).toFixed(0)}%), pooled ${(100 * pooledOut).toFixed(1)}% over n = ${found.reduce((s, p) => s + p.outN, 0)}`);
    // Expected count is about 25 (mostly length 6-7 sequences with n of 80-160); allow wide noise.
    expect(found.length).toBeGreaterThanOrEqual(8);
    expect(found.length).toBeLessThanOrEqual(60);
    expect(meanIn).toBeGreaterThanOrEqual(0.58);
    // Each pattern has n of roughly 80-160 out of sample (sd about 4-6 points); the mean of ~25 is within 4 points of 50%.
    expect(Math.abs(meanOut - 0.5)).toBeLessThan(0.04);
    expect(meanIn - meanOut).toBeGreaterThan(0.06);
  });
});
