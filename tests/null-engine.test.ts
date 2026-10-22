// The null engine on 20,000 random-walk candles scores 50% within noise, per asset class.

import { describe, expect, it } from 'vitest';
import { summarizeVotes, Z99 } from '../src/core/stats';
import { randomWalk } from '../src/harness/generators';
import { engineFactories } from '../src/harness/registry';
import { runDetailed } from '../src/harness/run';
import { syntheticSource } from '../src/harness/sources';

describe('null engine on a random walk', () => {
  it('accuracy sits inside its 99% interval around 50%, and its own stats match the ledger', async () => {
    const source = syntheticSource(randomWalk(), {
      candles: 20_000, ticksPerCandle: 4,
      assets: [{ asset: 'EURUSD_otc', isOTC: true }, { asset: 'EURUSD', isOTC: false }],
    });
    const { ledger, engines } = await runDetailed(source, engineFactories(['null']), 1);
    for (const isOTC of [true, false]) {
      const s = summarizeVotes(await ledger.queryVotes({ engine: 'null', isOTC }));
      const half = (Z99 * 0.5) / Math.sqrt(s.n);
      console.info(`null ${isOTC ? 'OTC' : 'live'}: accuracy ${(100 * s.accuracy!).toFixed(2)}% (n = ${s.n}, ties ${s.ties}), 99% band 50% +/- ${(100 * half).toFixed(2)}%`);
      expect(s.n).toBeGreaterThan(19_000);
      expect(Math.abs(s.accuracy! - 0.5)).toBeLessThan(half);
      const own = engines[0]!.stats(isOTC ? 'EURUSD_otc' : 'EURUSD');
      expect(own.votes).toBe(s.scored);
      expect(own.hits).toBe(s.hits);
      expect(own.ties).toBe(s.ties);
      expect(own.brier).toBeCloseTo(0.25, 12);
      expect(own.last200).not.toBeNull();
    }
  });
});
