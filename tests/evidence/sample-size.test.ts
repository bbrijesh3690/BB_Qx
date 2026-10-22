// BB_Qx.md Evidence 4: one-sided binomial test, 5% significance, 80% power, 55% vs 50%:
// about 600 scored votes. This is why no edge is claimed below n = 600.

import { describe, expect, it } from 'vitest';
import { exactPowerOneSided, sampleSizeOneSided } from '../../src/core/stats';

describe('evidence: sample size', () => {
  it('about 600 scored votes tell 55% from 50%', () => {
    const approx = sampleSizeOneSided(0.5, 0.55, 0.05, 0.8);
    let exact = 0;
    for (let n = 300; n <= 900 && !exact; n++) if (exactPowerOneSided(n, 0.5, 0.55, 0.05) >= 0.8) exact = n;
    const at600 = exactPowerOneSided(600, 0.5, 0.55, 0.05);
    console.info(`sample size: normal approximation ${approx}, smallest exact n with power >= 0.8: ${exact}, exact power at n = 600: ${at600.toFixed(3)}`);
    expect(approx).toBe(617);
    expect(exact).toBeGreaterThanOrEqual(550);
    expect(exact).toBeLessThanOrEqual(650);
    expect(at600).toBeGreaterThan(0.75);
    expect(at600).toBeLessThan(0.85);
    // Half the sample is far from enough.
    expect(exactPowerOneSided(300, 0.5, 0.55, 0.05)).toBeLessThan(0.6);
  });
});
