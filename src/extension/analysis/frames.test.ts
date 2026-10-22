// Runs the schema-mapping tool on scripts/fixtures/raw-frames.sample.ndjson, a HAND-MADE fixture
// shaped like the decoder's hypotheses (regenerate with scripts/fixtures/make-raw-frames-sample.ts).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DatasetMeta, MarketEvent } from '../../core/contracts';
import { analyzeFile } from '../../../scripts/analyze-frames';
import { FrameAnalyzer, formatReport, shapeOf } from './frames';

const FIXTURE = fileURLToPath(new URL('../../../scripts/fixtures/raw-frames.sample.ndjson', import.meta.url));

function analyzeFixture(collectDataset = false) {
  const a = new FrameAnalyzer({ collectDataset });
  for (const line of readFileSync(FIXTURE, 'utf8').split('\n')) a.addLine(line);
  return a;
}

describe('shapeOf', () => {
  it('describes JSON structure compactly', () => {
    expect(shapeOf([['A', 1.5, 2, 0], ['B', 2.5, 3, 1]])).toBe('[[string, float, int, int] ×2]');
    expect(shapeOf({ asset: 'A', period: 60, candles: [] })).toBe('{asset: string, period: int, candles: []}');
    expect(shapeOf(new Uint8Array([0xff]))).toBe('binary(1 bytes, not JSON)');
    expect(shapeOf([[[[[1]]]]])).toBe('[[[[[…]]]]]');
  });
});

describe('FrameAnalyzer on the hand-made fixture', () => {
  it('counts frames, directions, tabs and unreadable lines', () => {
    const r = analyzeFixture().report();
    expect(r).toMatchObject({ lines: 83, badLines: 1, frames: 82, byDir: { in: 77, out: 5 }, byEncoding: { text: 46, base64: 36 }, tabs: [11, 22] });
    expect(r.orphanBinaries).toBe(0);
  });

  it('lists event names with direction, count and payload shape', () => {
    const r = analyzeFixture().report();
    const quotes = r.events.find((e) => e.name === 'quotes/stream')!;
    expect(quotes).toMatchObject({ dir: 'in', count: 34, withAttachments: 34 });
    expect(quotes.shape).toContain('string, float, float, int');
    expect(quotes.timestamps.guess).toBe('seconds (fractional, sub-second precision)');
    expect(quotes.timestamps.medianOffsetVsLocalMs).toBeGreaterThan(1000);
    expect(r.events.find((e) => e.name === 'instruments/update')).toMatchObject({ dir: 'out', shape: '{asset: string, period: int}' });
    expect(r.events.map((e) => `${e.dir} ${e.name}`)).toContain('in s_balance');
  });

  it('finds asset ids, candle field order, and tick rates through the current decoder', () => {
    const r = analyzeFixture().report();
    expect(r.assetLike.map((a) => a.value)).toEqual(['EURUSD_otc', 'GBPUSD']);
    expect(r.candleRows).toEqual({ rows: 4, tOpenCloseHighLow: 4, tOpenHighLowClose: 0 });
    const ticks = Object.fromEntries(r.decoder.ticks.map((t) => [t.asset, t]));
    expect(ticks.EURUSD_otc).toMatchObject({ isOTC: true, count: 20, duplicates: 4 });
    expect(ticks.EURUSD_otc!.perMinute).toBeCloseTo(120, 5);
    expect(ticks.GBPUSD).toMatchObject({ isOTC: false, count: 10 });
    expect(r.decoder.unknown).toEqual({ 'out authorization': 1, 'in s_authorization': 1, 'in s_balance': 1, 'out tick': 1 });
  });

  it('formats a readable report', () => {
    const text = formatReport(analyzeFixture().report());
    for (const s of ['== Event names', 'in  quotes/stream  ×34', '== Asset-like strings', 'EURUSD_otc ×', '[ts, open, close, high, low] 100.0%', 'rate 120.0/min']) {
      expect(text).toContain(s);
    }
  });

  it('converts the frames into a time-ordered bbqx-dataset', () => {
    const lines = analyzeFixture(true).datasetLines(7);
    const meta = JSON.parse(lines[0]!) as DatasetMeta;
    expect(meta).toMatchObject({ format: 'bbqx-dataset', version: 1, createdAt: 7 });
    expect(meta.assets).toEqual([
      { asset: 'EURUSD_otc', isOTC: true, payoutPercent: 92 },
      { asset: 'GBPUSD', isOTC: false, payoutPercent: 85 },
    ]);
    const events = lines.slice(1).map((l) => JSON.parse(l) as MarketEvent);
    expect(events.filter((e) => e.kind === 'tick')).toHaveLength(30);
    expect(events.filter((e) => e.kind === 'candle')).toHaveLength(2);
    const at = (e: MarketEvent) => (e.kind === 'candle' ? e.candle.openTs + 60_000 : e.ts);
    for (let i = 1; i < events.length; i++) expect(at(events[i]!)).toBeGreaterThanOrEqual(at(events[i - 1]!));
  });
});

describe('scripts/analyze-frames', () => {
  it('reads an NDJSON file, prints the report and writes the dataset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bbqx-analyze-'));
    try {
      const out = join(dir, 'dataset.ndjson');
      const text = await analyzeFile(FIXTURE, { dataset: out });
      expect(text).toContain('== Frames ==');
      const lines = readFileSync(out, 'utf8').trim().split('\n');
      expect(JSON.parse(lines[0]!).format).toBe('bbqx-dataset');
      expect(lines.length).toBe(1 + 30 + 2 + 2);
      expect(JSON.parse(await analyzeFile(FIXTURE, { json: true })).frames).toBe(82);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
