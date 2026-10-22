import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { DatasetMeta, MarketEvent } from '../core/contracts';
import { openIndexedDbLedger } from '../ledger/indexeddb';
import { datasetChunks, rawFrameChunks, type Progress } from './exporter';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
let n = 0;

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  let text = '';
  for await (const chunk of gen) {
    expect(chunk.endsWith('\n')).toBe(true);
    text += chunk;
  }
  return text.split('\n').filter((l) => l.length > 0);
}

describe('rawFrameChunks', () => {
  it('writes every frame once, in seq order, across pages', async () => {
    const ledger = await openIndexedDbLedger(`export-raw-${++n}`);
    const frames = Array.from({ length: 23 }, (_, i) => ({ receivedAt: T0 + i, tabId: i % 2, socketUrl: 'wss://x', dir: 'in' as const, encoding: 'text' as const, data: `f${i}` }));
    await ledger.appendRawFrames(frames);
    const progress: Progress[] = [];
    const lines = await collect(rawFrameChunks(ledger, (p) => progress.push(p), 5));
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.map((f) => f.data)).toEqual(frames.map((f) => f.data));
    expect(Object.keys(parsed[0])).toEqual(['seq', 'receivedAt', 'tabId', 'socketUrl', 'dir', 'encoding', 'data']);
    expect(progress.at(-1)).toEqual({ done: 23, total: 23 });
  });

  it('writes nothing for an empty store', async () => {
    const ledger = await openIndexedDbLedger(`export-raw-${++n}`);
    expect(await collect(rawFrameChunks(ledger))).toEqual([]);
  });
});

describe('datasetChunks', () => {
  it('writes a meta line, then ticks, feed candles (at close) and payouts merged by time', async () => {
    const ledger = await openIndexedDbLedger(`export-ds-${++n}`);
    await ledger.appendTicks([
      { asset: 'EURUSD_otc', ts: T0 + 1000, price: 1.1 },
      { asset: 'EURUSD_otc', ts: T0 + MIN, price: 1.2 },
      { asset: 'GBPUSD', ts: T0 + 500, price: 1.3 },
      { asset: 'GBPUSD', ts: T0 + MIN + 1, price: 1.31 },
    ]);
    const c = { open: 1, high: 2, low: 0.5, close: 1.5, tickCount: 0 };
    await ledger.putCandle({ ...c, asset: 'EURUSD_otc', isOTC: true, tf: '1m', openTs: T0, source: 'feed' });
    await ledger.putCandle({ ...c, asset: 'EURUSD_otc', isOTC: true, tf: '1m', openTs: T0 + MIN, source: 'rebuilt' });
    await ledger.putCandle({ ...c, asset: 'AUDCAD_otc', isOTC: true, tf: '5m', openTs: T0 - 5 * MIN, source: 'feed' });
    await ledger.appendPayout({ asset: 'EURUSD_otc', ts: T0, percent: 85 });
    await ledger.appendPayout({ asset: 'EURUSD_otc', ts: T0 + MIN, percent: 88 });
    await ledger.appendPayout({ asset: 'NZDJPY', ts: T0, percent: 70 }); // no ticks or candles: left out

    const lines = await collect(datasetChunks(ledger, 42, undefined, 2));
    const meta = JSON.parse(lines[0]!) as DatasetMeta;
    expect(meta).toMatchObject({
      format: 'bbqx-dataset',
      version: 1,
      createdAt: 42,
      assets: [
        { asset: 'AUDCAD_otc', isOTC: true, payoutPercent: 0 },
        { asset: 'EURUSD_otc', isOTC: true, payoutPercent: 88 },
        { asset: 'GBPUSD', isOTC: false, payoutPercent: 0 },
      ],
    });
    expect(meta.note).toContain('AUDCAD_otc, GBPUSD');

    const events = lines.slice(1).map((l) => JSON.parse(l) as MarketEvent);
    const short = events.map((e) => {
      if (e.kind === 'candle') return `candle ${e.asset} ${e.tf} ${e.candle.openTs - T0}`;
      if (e.kind === 'clock') return 'clock';
      return `${e.kind} ${e.asset} ${e.ts - T0}`;
    });
    expect(short).toEqual([
      `candle AUDCAD_otc 5m ${-5 * MIN}`, // closes at T0
      'payout EURUSD_otc 0',
      'tick GBPUSD 500',
      'tick EURUSD_otc 1000',
      `tick EURUSD_otc ${MIN}`, // tick before the candle that closes at the same instant
      `candle EURUSD_otc 1m 0`,
      `payout EURUSD_otc ${MIN}`,
      `tick GBPUSD ${MIN + 1}`,
    ]);
    expect(events.find((e) => e.kind === 'tick' && e.asset === 'EURUSD_otc')).toEqual({ kind: 'tick', asset: 'EURUSD_otc', isOTC: true, ts: T0 + 1000, price: 1.1 });
    expect(events.find((e) => e.kind === 'candle' && e.asset === 'EURUSD_otc')).toEqual({
      kind: 'candle', asset: 'EURUSD_otc', isOTC: true, tf: '1m', candle: { openTs: T0, open: 1, high: 2, low: 0.5, close: 1.5, tickCount: 0 },
    });
  });

  it('is deterministic for the same database', async () => {
    const ledger = await openIndexedDbLedger(`export-ds-${++n}`);
    await ledger.appendTicks(Array.from({ length: 50 }, (_, i) => ({ asset: i % 2 ? 'A' : 'B', ts: T0 + Math.floor(i / 2) * 10, price: 1 + i })));
    const a = await collect(datasetChunks(ledger, 1, undefined, 7));
    const b = await collect(datasetChunks(ledger, 1, undefined, 3));
    expect(a).toEqual(b);
    expect(a).toHaveLength(51);
  });

  it('writes only the meta line for an empty ledger', async () => {
    const ledger = await openIndexedDbLedger(`export-ds-${++n}`);
    const lines = await collect(datasetChunks(ledger, 1));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).assets).toEqual([]);
  });
});
