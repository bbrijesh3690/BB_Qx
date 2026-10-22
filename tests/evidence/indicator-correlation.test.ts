// BB_Qx.md Evidence 2: on 1m random-walk candles, six indicators carry about two pieces of
// information. Brief: Stoch vs Williams %R = 1.00; RSI/Stoch/CCI 0.80-0.92; EMA 9-21 vs MACD 0.98.

import { describe, expect, it } from 'vitest';
import { pearson } from '../../src/core/stats';
import { randomWalk, syntheticCandles } from '../../src/harness/generators';
import { cci, emaSpread, rsi, stochK, williamsR } from './indicators';

describe('evidence: indicator correlation', () => {
  it('range-position indicators move together, and so do the drift indicators', () => {
    const cs = syntheticCandles(randomWalk(), 7, { asset: 'EURUSD_otc', isOTC: true, startPrice: 1.085 }, { candles: 20_000 });
    const closes = cs.map((c) => c.close);
    const series = {
      rsi: rsi(closes, 14), stoch: stochK(cs, 14), wr: williamsR(cs, 14), cci: cci(cs, 20),
      ema: emaSpread(closes, 9, 21), macd: emaSpread(closes, 12, 26),
    };
    const start = 60; // past every warmup
    const corr = (a: keyof typeof series, b: keyof typeof series) => pearson(series[a].slice(start), series[b].slice(start));
    const r = {
      stochWr: corr('stoch', 'wr'), rsiStoch: corr('rsi', 'stoch'), rsiCci: corr('rsi', 'cci'),
      stochCci: corr('stoch', 'cci'), emaMacd: corr('ema', 'macd'), rsiEma: corr('rsi', 'ema'),
    };
    console.info(`indicator correlation (n = ${cs.length - start}): ` + Object.entries(r).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(', '));
    expect(r.stochWr).toBeGreaterThan(0.9999); // %R is %K - 100
    for (const v of [r.rsiStoch, r.rsiCci, r.stochCci]) {
      expect(v).toBeGreaterThan(0.75);
      expect(v).toBeLessThan(0.97);
    }
    expect(r.emaMacd).toBeGreaterThan(0.95);
  });
});
