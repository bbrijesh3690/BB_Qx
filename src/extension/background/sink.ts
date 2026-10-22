// The seam between the feed and the core. The worker hands every decoded MarketEvent to a sink.
// At runtime that sink is the core Pipeline: it builds candles, freezes votes at T-5s and scores
// them. createDirectSink (ledger writes only, no engines) stays for tests of the feed processor.

import type { Engine, Ledger, MarketEvent, MarketEventSink, TickRecord } from '../../core/contracts';
import { Pipeline } from '../../core/pipeline';
import { TUNABLES } from '../../core/tunables';
import { feedStructureFactory } from '../../engines/feed-structure';
import { nullEngine } from '../../engines/null';
import { priceActionFactory } from '../../engines/price-action';

/** A sink may buffer; the worker calls flush() after each batch when it exists. */
export interface FeedSink extends MarketEventSink {
  flush?(): Promise<void>;
}

const TICK_BATCH = 500; // TUNABLE: ticks per IndexedDB transaction if a single batch is unusually large
const ENGINE_SEED = 1; // fixed so the null engine's coin flips are reproducible from the ledger
const MIN_MS = 60_000;

/** The phase 0 engine committee: null baseline, feed structure, price action. */
export function runtimeEngines(): Engine[] {
  return [nullEngine(ENGINE_SEED), feedStructureFactory(ENGINE_SEED), priceActionFactory(ENGINE_SEED)];
}

/**
 * The runtime sink. After a worker restart it restores each engine's saved state and each asset's
 * recent candles and payout from the ledger, so engines don't sit in warmup again. `wallNow` is the
 * local clock, used only to bound how much history to load. Restore problems are logged, not fatal.
 */
export async function createPipelineSink(ledger: Ledger, wallNow: number, engines: Engine[] = runtimeEngines()): Promise<Pipeline> {
  const problems: string[] = [];
  for (const e of engines) {
    try {
      const saved = await ledger.getEngineState(e.id);
      if (saved) e.restore(saved.state);
    } catch (err) {
      problems.push(`restore ${e.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const pipeline = new Pipeline({ ledger, engines, tf: '1m', partialStartToleranceMs: TUNABLES.partialStartToleranceMs.value }); // TUNABLE: partialStartToleranceMs
  const fromTs = wallNow - (TUNABLES.contextCandles.value + 5) * MIN_MS;
  let restoredAssets = 0;
  try {
    for (const { asset, isOTC } of await ledger.listAssets()) {
      const candles = await ledger.getCandles(asset, '1m', { fromTs });
      const payout = await ledger.latestPayout(asset, wallNow + 10 * MIN_MS);
      if (candles.length === 0 && !payout) continue;
      pipeline.preload(asset, isOTC, candles, payout);
      restoredAssets++;
    }
  } catch (err) {
    problems.push(`preload: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (restoredAssets > 0 || problems.length > 0) {
    await ledger.appendEvent({ ts: wallNow, kind: 'reload', payload: { restoredAssets, problems } }).catch(() => undefined);
  }
  return pipeline;
}

/** Ledger writes only: ticks, payouts and feed candles, no candle building or engines. */
export function createDirectSink(ledger: Ledger): FeedSink {
  let ticks: TickRecord[] = [];
  const flush = async () => {
    if (ticks.length === 0) return;
    const batch = ticks;
    ticks = [];
    await ledger.appendTicks(batch);
  };
  return {
    async onEvent(ev: MarketEvent) {
      switch (ev.kind) {
        case 'tick':
          ticks.push({ asset: ev.asset, ts: ev.ts, price: ev.price });
          if (ticks.length >= TICK_BATCH) await flush();
          return;
        case 'history':
          for (const t of ev.ticks) ticks.push({ asset: ev.asset, ts: t.ts, price: t.price });
          if (ticks.length >= TICK_BATCH) await flush();
          return;
        case 'payout':
          await ledger.appendPayout({ asset: ev.asset, ts: ev.ts, percent: ev.percent });
          return;
        case 'candle':
          await ledger.putCandle({ ...ev.candle, asset: ev.asset, isOTC: ev.isOTC, tf: ev.tf, source: 'feed' });
          return;
        case 'clock':
          return;
      }
    },
    flush,
  };
}
