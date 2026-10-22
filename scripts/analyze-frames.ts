// Schema-mapping tool for exported raw frames.
//   npm run analyze-frames -- <raw-frames.ndjson> [--dataset <out.ndjson>] [--json]
// Prints event names with counts and direction, a payload shape and sample per event name, asset
// ids seen, tick rate per asset (through the current decoder mapping) and a timestamp-unit guess.
// --dataset also writes a bbqx-dataset file decoded from the frames with the current mapping,
// which covers the whole recording (the ledger itself keeps only 2 h of ticks).

import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { FrameAnalyzer, formatReport } from '../src/extension/analysis/frames';

const USAGE = 'usage: npm run analyze-frames -- <raw-frames.ndjson> [--dataset <out.ndjson>] [--json]';

export async function analyzeFile(file: string, opts: { dataset?: string; json?: boolean } = {}): Promise<string> {
  const analyzer = new FrameAnalyzer({ collectDataset: opts.dataset !== undefined });
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) analyzer.addLine(line);
  const report = analyzer.report();
  if (opts.dataset !== undefined) {
    const out = createWriteStream(opts.dataset, 'utf8');
    for (const line of analyzer.datasetLines(Date.now())) {
      if (!out.write(line + '\n')) await once(out, 'drain');
    }
    out.end();
    await once(out, 'finish');
  }
  return opts.json ? JSON.stringify(report, null, 2) : formatReport(report);
}

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  let file: string | undefined;
  let dataset: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--dataset') dataset = args[++i];
    else if (a === '--json') json = true;
    else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      return 0;
    } else file = a;
  }
  if (!file || (args.includes('--dataset') && !dataset)) {
    console.error(USAGE);
    return 2;
  }
  console.log(await analyzeFile(file, { dataset, json }));
  if (dataset) console.error(`dataset written to ${dataset}`);
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && /analyze-frames\.ts$/.test(process.argv[1].replace(/\\/g, '/'));
if (invokedDirectly) {
  main(process.argv).then(
    (code) => (process.exitCode = code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    },
  );
}
