// Command line for the replay harness. Run `npm run harness -- --help`.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { DataSource, Timeframe } from '../core/contracts';
import { TUNABLES } from '../core/tunables';
import { bounded, DEFAULT_ASSETS, randomWalk, regimeSwitching, trending, type PriceModel, type SyntheticAsset } from './generators';
import { engineFactories, engineIds } from './registry';
import { formatScoreboard, scoreboard } from './report';
import { runDetailed } from './run';
import { datasetOf, recordedSource, syntheticSource } from './sources';

export const USAGE = `BB_Qx replay harness

Usage: npm run harness -- [options]

Source (one of):
  --source <name>       synthetic feed: random | bounded | trending | regime   (default random)
  --dataset <file>      replay a recorded bbqx-dataset NDJSON file instead

Synthetic feed options:
  --candles <n>         candles per asset                                       (default 20000)
  --k <x>               anchor pull for bounded and regime                      (default ${TUNABLES.syntheticBoundedK.value})
  --drift <x>           log-price drift per candle for trending and regime      (default ${TUNABLES.syntheticTrendDrift.value})
  --segment <n>         candles per regime for regime                           (default ${TUNABLES.syntheticRegimeCandles.value})
  --sigma <x>           log-price volatility per candle                         (default ${TUNABLES.syntheticSigma.value})
  --ticks <n>           ticks per candle                                        (default ${TUNABLES.syntheticTicksPerCandle.value})
  --assets <a,b,...>    asset ids; ids ending in _otc are OTC     (default ${DEFAULT_ASSETS.map((a) => a.asset).join(',')})
  --market-hours        live assets go quiet while the live market is closed

Run options:
  --seed <n>            seed for the source and the engines                     (default 1)
  --engines <a,b,...>   engines to run; the null engine is always added         (known: ${engineIds().join(', ')})
  --tf <1m|2m|5m>       timeframe                                               (default 1m)
  --out <file>          write the ledger export (JSON) to a file
  --write-dataset <f>   also write the source events as a bbqx-dataset NDJSON file
  --help                show this help

Example: npm run harness -- --source bounded --k 0.08 --candles 20000 --seed 1 --engines null
`;

export interface CliOptions {
  source: string;
  dataset?: string;
  candles: number;
  k?: number;
  drift?: number;
  segment?: number;
  sigma?: number;
  ticks?: number;
  assets?: string[];
  marketHours: boolean;
  seed: number;
  engines: string[];
  tf: Timeframe;
  out?: string;
  writeDataset?: string;
  help: boolean;
}

const FLAGS = new Set(['--help', '-h', '--market-hours']);

export function parseArgs(argv: readonly string[]): CliOptions {
  const o: CliOptions = { source: 'random', candles: 20_000, marketHours: false, seed: 1, engines: ['null'], tf: '1m', help: false };
  const num = (flag: string, v: string) => {
    const x = Number(v);
    if (v.trim() === '' || !Number.isFinite(x)) throw new Error(`${flag} needs a number, got '${v}'`);
    return x;
  };
  const int = (flag: string, v: string) => {
    const x = num(flag, v);
    if (!Number.isInteger(x) || x < 0) throw new Error(`${flag} needs a non-negative integer, got '${v}'`);
    return x;
  };
  const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (FLAGS.has(flag)) {
      if (flag === '--market-hours') o.marketHours = true;
      else o.help = true;
      continue;
    }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    i++;
    switch (flag) {
      case '--source': o.source = v; break;
      case '--dataset': o.dataset = v; break;
      case '--candles': o.candles = int(flag, v); break;
      case '--k': o.k = num(flag, v); break;
      case '--drift': o.drift = num(flag, v); break;
      case '--segment': o.segment = int(flag, v); break;
      case '--sigma': o.sigma = num(flag, v); break;
      case '--ticks': o.ticks = int(flag, v); break;
      case '--assets': o.assets = list(v); break;
      case '--seed': o.seed = int(flag, v); break;
      case '--engines': o.engines = list(v); break;
      case '--tf':
        if (v !== '1m' && v !== '2m' && v !== '5m') throw new Error(`--tf must be 1m, 2m or 5m, got '${v}'`);
        o.tf = v;
        break;
      case '--out': o.out = v; break;
      case '--write-dataset': o.writeDataset = v; break;
      default: throw new Error(`unknown option ${flag} (see --help)`);
    }
  }
  if (!o.engines.includes('null')) o.engines = ['null', ...o.engines];
  return o;
}

export function modelOf(o: CliOptions): PriceModel {
  switch (o.source) {
    case 'random': return randomWalk();
    case 'bounded': return bounded(o.k);
    case 'trending': return trending(o.drift);
    case 'regime': return regimeSwitching({
      ...(o.segment !== undefined ? { segmentCandles: o.segment } : {}),
      ...(o.k !== undefined ? { k: o.k } : {}),
      ...(o.drift !== undefined ? { drift: o.drift } : {}),
    });
    default: throw new Error(`unknown source '${o.source}': use random, bounded, trending or regime`);
  }
}

export function sourceOf(o: CliOptions, readText: (path: string) => string): DataSource {
  if (o.dataset) return recordedSource(readText(o.dataset));
  const assets: SyntheticAsset[] | undefined = o.assets?.map((asset) => {
    const known = DEFAULT_ASSETS.find((a) => a.asset === asset);
    return known ? { ...known } : { asset, isOTC: asset.endsWith('_otc') };
  });
  return syntheticSource(modelOf(o), {
    candles: o.candles, tf: o.tf, marketHours: o.marketHours,
    ...(assets ? { assets } : {}),
    ...(o.sigma !== undefined ? { sigma: o.sigma } : {}),
    ...(o.ticks !== undefined ? { ticksPerCandle: o.ticks } : {}),
  });
}

export interface CliIO {
  log: (line: string) => void;
  readText: (path: string) => string;
  writeText: (path: string, text: string) => void;
}

const nodeIO: CliIO = {
  log: (line) => console.log(line),
  readText: (path) => readFileSync(path, 'utf8'),
  writeText: (path, text) => writeFileSync(path, text),
};

/** Runs the harness and prints the scoreboard. Returns the process exit code. */
export async function main(argv: readonly string[], io: CliIO = nodeIO): Promise<number> {
  let o: CliOptions;
  try {
    o = parseArgs(argv);
    if (o.help) { io.log(USAGE); return 0; }
    const source = sourceOf(o, io.readText);
    const factories = engineFactories(o.engines);
    if (o.writeDataset) io.writeText(o.writeDataset, datasetOf(source, o.seed, `${source.id} seed ${o.seed}`));
    const { ledger, events } = await runDetailed(source, factories, o.seed, { tf: o.tf });
    const counts = await ledger.countCandles();
    const kinds = ['feed_gap', 'candle_mismatch', 'info'] as const;
    const eventCounts = await Promise.all(kinds.map(async (kind) => `${kind} ${(await ledger.listEvents({ kind })).length}`));
    io.log(`source ${source.id}, seed ${o.seed}, tf ${o.tf}, engines ${o.engines.join(', ')}`);
    io.log(`events ${events}; candles ${Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(' ')}; ${eventCounts.join(', ')}`);
    io.log('');
    io.log(formatScoreboard(await scoreboard(ledger, o.engines)));
    if (o.out) {
      io.writeText(o.out, JSON.stringify(await ledger.export()));
      io.log(`\nledger written to ${o.out}`);
    }
    return 0;
  } catch (err) {
    io.log(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
