import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { MarketEvent } from '../../core/contracts';
import { bounded, syntheticEvents, SYNTHETIC_START_TS } from '../../harness/generators';
import { openIndexedDbLedger } from '../../ledger/indexeddb';
import { createPipelineSink, runtimeEngines } from './sink';

const M = 60_000;
const ASSET = { asset: 'EURUSD_otc', isOTC: true, payout: 85 };

function events(candles: number): MarketEvent[] {
  return [...syntheticEvents(bounded(0.2), 7, { candles, assets: [ASSET], ticksPerCandle: 6 })];
}

async function feed(sink: { onEvent(e: MarketEvent): Promise<void>; flush(): Promise<void> }, evs: MarketEvent[]) {
  for (const e of evs) await sink.onEvent(e);
  await sink.flush();
}

describe('createPipelineSink', () => {
  it('runs the phase 0 committee against the IndexedDB ledger: candles, votes and scored outcomes', async () => {
    const ledger = await openIndexedDbLedger('sink-pipeline-1');
    await feed(await createPipelineSink(ledger, SYNTHETIC_START_TS), events(40));
    expect((await ledger.getCandles(ASSET.asset, '1m')).length).toBeGreaterThanOrEqual(38);
    const nulls = await ledger.queryVotes({ engine: 'null', scoredOnly: true });
    expect(nulls.length).toBeGreaterThanOrEqual(35);
    expect(nulls.every((v) => v.vote.payoutAtVote === 0.85)).toBe(true);
    const engines = new Set((await ledger.queryVotes({})).map((v) => v.vote.engine));
    expect([...engines].sort()).toEqual(['null', 'price-action']); // feed-structure describes, it doesn't vote
  });

  it('after a restart, restores engine state and candle history instead of warming up again', async () => {
    const ledger = await openIndexedDbLedger('sink-pipeline-2');
    const all = events(260);
    const cut = all.findIndex((e) => e.kind === 'tick' && e.ts >= SYNTHETIC_START_TS + 200 * M + 20_000);
    await feed(await createPipelineSink(ledger, SYNTHETIC_START_TS), all.slice(0, cut));
    const before = (await ledger.queryVotes({ engine: 'null', scoredOnly: true })).length;

    // The worker restarts mid-candle; the new pipeline starts from what the ledger holds.
    const fresh = runtimeEngines();
    const restarted = await createPipelineSink(ledger, SYNTHETIC_START_TS + 200 * M, fresh);
    expect(fresh.find((e) => e.id === 'null')!.stats(ASSET.asset).votes).toBeGreaterThan(0);
    expect(restarted.builder.closed(ASSET.asset).length).toBeGreaterThanOrEqual(195);
    await feed(restarted, all.slice(cut));

    const reloads = await ledger.listEvents({ kind: 'reload' });
    expect(reloads.at(-1)!.payload).toMatchObject({ restoredAssets: 1, problems: [] });
    // Feed-structure needs 200 candles: with history restored it labels right away, not after 200 more.
    const fs = (await ledger.export()).feedStructure.filter((r) => r.ts > SYNTHETIC_START_TS + 201 * M);
    expect(fs.length).toBeGreaterThan(50);
    expect((await ledger.queryVotes({ engine: 'null', scoredOnly: true })).length).toBeGreaterThan(before + 50);
  });
});
