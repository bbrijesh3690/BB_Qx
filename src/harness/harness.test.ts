import { describe, expect, it } from 'vitest';
import { main, parseArgs, USAGE } from './cli';
import { randomWalk } from './generators';
import { engineFactories } from './registry';
import { run } from './run';
import { datasetOf, recordedSource, syntheticSource } from './sources';

const small = { candles: 30, assets: [{ asset: 'EURUSD_otc', isOTC: true }, { asset: 'EURUSD', isOTC: false }] };

describe('harness', () => {
  it('run() returns a ledger with null votes and outcomes', async () => {
    const ledger = await run(syntheticSource(randomWalk(), small), engineFactories(['null']), 1);
    const e = await ledger.export();
    expect(e.votes.length).toBe(2 * 30);
    expect(e.outcomes.length).toBe(2 * 28); // the last two predicted candles never close in the data
    expect(e.candles.length).toBe(2 * 29);
  });

  it('registry knows null and rejects unknown ids', () => {
    expect(engineFactories(['null'])).toHaveLength(1);
    expect(() => engineFactories(['nope'])).toThrow(/unknown engine 'nope'; known: null/);
  });

  it('recordedSource round-trips a synthetic dataset and rejects malformed files', () => {
    const src = syntheticSource(randomWalk(), small);
    const text = datasetOf(src, 3, 'test');
    const rec = recordedSource(text);
    expect(rec.id).toBe('recorded:2026-01-05');
    expect(rec.assets).toEqual(src.assets);
    expect(JSON.stringify([...rec.events(99)])).toBe(JSON.stringify([...src.events(3)]));
    expect(() => recordedSource('')).toThrow(/empty/);
    expect(() => recordedSource('{"format":"other"}')).toThrow(/header/);
    const header = text.split('\n')[0]!;
    expect(() => recordedSource(`${header}\n{"kind":"tick","asset":"A","isOTC":true,"ts":1}`)).toThrow(/line 2: tick event has a bad price/);
    expect(() => recordedSource(`${header}\nnot json`)).toThrow(/line 2: not JSON/);
    expect(() => recordedSource(`${header}\n{"kind":"bar"}`)).toThrow(/unknown event kind/);
  });

  it('parseArgs reads options, always adds the null engine, and rejects bad input', () => {
    const o = parseArgs(['--source', 'bounded', '--k', '0.08', '--candles', '500', '--seed', '7', '--engines', 'priceAction', '--market-hours']);
    expect(o).toMatchObject({ source: 'bounded', k: 0.08, candles: 500, seed: 7, engines: ['null', 'priceAction'], marketHours: true });
    expect(parseArgs([]).engines).toEqual(['null']);
    expect(() => parseArgs(['--candles', 'x'])).toThrow(/number/);
    expect(() => parseArgs(['--bogus', '1'])).toThrow(/unknown option/);
    expect(() => parseArgs(['--seed'])).toThrow(/needs a value/);
  });

  it('main prints help, a scoreboard with n and CI, and writes outputs', async () => {
    const lines: string[] = [];
    const files: Record<string, string> = {};
    const io = { log: (l: string) => lines.push(l), readText: (p: string) => files[p]!, writeText: (p: string, t: string) => { files[p] = t; } };
    expect(await main(['--help'], io)).toBe(0);
    expect(lines[0]).toBe(USAGE);
    lines.length = 0;
    const code = await main(['--source', 'random', '--candles', '200', '--assets', 'EURUSD_otc,EURUSD', '--out', 'l.json', '--write-dataset', 'd.ndjson'], io);
    expect(code).toBe(0);
    const out = lines.join('\n');
    expect(out).toMatch(/engine\s+class\s+votes\s+abstains\s+scored\s+ties\s+n\s+hits\s+accuracy\s+95% CI/);
    expect(out).toMatch(/null\s+OTC\s+200/);
    expect(out).toMatch(/null\s+live\s+200/);
    expect(out).toContain('building sample');
    expect(JSON.parse(files['l.json']!).format).toBe('bbqx-ledger');
    lines.length = 0;
    expect(await main(['--dataset', 'd.ndjson'], io)).toBe(0);
    expect(lines.join('\n')).toContain('source recorded:2026-01-05');
    expect(await main(['--source', 'nope'], io)).toBe(1);
  });
});
