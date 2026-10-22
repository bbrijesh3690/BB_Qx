// The seam between the feed and the core. Phase 0: write ticks, payouts and feed candles straight
// to the ledger. At integration the lead replaces createSink with the core Pipeline (which
// implements MarketEventSink); nothing else in the worker needs to change.

import type { Ledger, MarketEvent, MarketEventSink, TickRecord } from '../../core/contracts';

/** A sink may buffer; the worker calls flush() after each batch when it exists. */
export interface FeedSink extends MarketEventSink {
  flush?(): Promise<void>;
}

const TICK_BATCH = 500; // TUNABLE: ticks per IndexedDB transaction if a single batch is unusually large

export function createSink(ledger: Ledger): FeedSink {
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
