// Harness contract: identical (source, engines, seed) give a byte-identical ledger export.

import { describe, expect, it } from 'vitest';
import type { DataSource, MarketEvent } from '../src/core/contracts';
import { bounded, regimeSwitching, syntheticCandles, type SyntheticAsset } from '../src/harness/generators';
import { engineFactories } from '../src/harness/registry';
import { run } from '../src/harness/run';
import { datasetOf, recordedSource, syntheticSource, toNdjson } from '../src/harness/sources';

const M = 60_000;
const nullOnly = engineFactories(['null']);
const exportOf = async (source: DataSource, seed: number) => JSON.stringify(await (await run(source, nullOnly, seed)).export({ includeTicks: true }));

describe('determinism', () => {
  it('the same source, engines and seed give an identical ledger; another seed does not', async () => {
    const source = syntheticSource(regimeSwitching({ segmentCandles: 300 }), { candles: 3000, marketHours: true });
    const a = await exportOf(source, 1);
    const b = await exportOf(source, 1);
    const c = await exportOf(source, 2);
    expect(a.length).toBeGreaterThan(100_000);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('a recorded synthetic day (with feed candles and clock events) replays identically, and matches the live run', async () => {
    const assets: SyntheticAsset[] = [{ asset: 'EURUSD_otc', isOTC: true }, { asset: 'GBPUSD', isOTC: false }];
    const opts = { candles: 1440, assets };
    const synthetic = syntheticSource(bounded(0.08), opts);

    // Plain round trip: the NDJSON replay equals running the generator directly.
    const recorded = recordedSource(datasetOf(synthetic, 5, 'synthetic day'));
    expect(recorded.id).toBe('recorded:2026-01-05');
    expect(await exportOf(recorded, 5)).toBe(await exportOf(synthetic, 5)); // the seed still drives the engines

    // A richer recording: feed candles shortly after each close (every 7th disagreeing a little) and a clock heartbeat.
    const feed = syntheticCandles(bounded(0.08), 5, assets[0]!, opts);
    const events: MarketEvent[] = [];
    let next = 0;
    for (const ev of synthetic.events(5)) {
      if (ev.kind === 'tick' && ev.asset === 'GBPUSD' && ev.ts % M === 0) {
        const c = feed[next];
        if (c && c.openTs + M <= ev.ts) {
          const close = next % 7 === 0 ? c.close + 0.0003 : c.close;
          events.push({ kind: 'candle', asset: 'EURUSD_otc', isOTC: true, tf: '1m', candle: { ...c, close } });
          events.push({ kind: 'clock', ts: ev.ts + 1500 });
          next++;
        }
      }
      events.push(ev);
    }
    const text = toNdjson({ format: 'bbqx-dataset', version: 1, createdAt: 0, assets: synthetic.assets, note: 'rich' }, events);
    const first = await exportOf(recordedSource(text), 1);
    const second = await exportOf(recordedSource(text), 1);
    expect(first).toBe(second);
    const parsed = JSON.parse(first);
    expect(parsed.candles.filter((c: { source: string }) => c.source === 'feed').length).toBeGreaterThan(1000);
    expect(parsed.events.filter((e: { kind: string }) => e.kind === 'candle_mismatch').length).toBeGreaterThan(100);
  });
});
