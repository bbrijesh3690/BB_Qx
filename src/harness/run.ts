// Harness contract: run(source, engines, seed) -> ledger. Identical inputs give a byte-identical
// ledger export, because every part (source, engines, pipeline, memory ledger) is deterministic.

import type { DataSource, Engine, EngineFactory, HarnessRun, RunOptions } from '../core/contracts';
import { Pipeline } from '../core/pipeline';
import { TUNABLES } from '../core/tunables';
import { MemoryLedger } from '../ledger/memory';

export interface RunResult {
  ledger: MemoryLedger;
  engines: Engine[];
  pipeline: Pipeline;
  events: number;
}

/** Like run(), but also returns the engines (for their stats) and the pipeline. */
export async function runDetailed(source: DataSource, factories: EngineFactory[], seed: number, opts: RunOptions = {}): Promise<RunResult> {
  const ledger = new MemoryLedger();
  const engines = factories.map((f) => f(seed));
  const pipeline = new Pipeline({
    ledger,
    engines,
    tf: opts.tf ?? '1m',
    freezeBeforeCloseMs: opts.freezeBeforeCloseMs ?? TUNABLES.freezeBeforeCloseMs.value,
    confirmDelayMs: opts.confirmDelayMs ?? TUNABLES.confirmDelayMs.value,
  });
  let events = 0;
  for (const ev of source.events(seed)) {
    await pipeline.onEvent(ev);
    events++;
  }
  await pipeline.flush();
  return { ledger, engines, pipeline, events };
}

export const run: HarnessRun = async (source, engines, seed, opts) => (await runDetailed(source, engines, seed, opts)).ledger;
