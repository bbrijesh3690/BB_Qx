// NDJSON exports read straight from the extension's IndexedDB, page by page, so a 100+ MB export
// never holds more than one page of records (plus the output) at a time.
//
// Dataset ordering: events are ordered by the time they become known. A tick or payout at its ts;
// a feed candle at its close (openTs + tf), because a candle event means "this candle closed".
// Ties: tick, then candle, then payout, then asset, then tf.

import { TF_MS, type DatasetMeta, type MarketEvent, type SourceAsset } from '../core/contracts';
import type { IndexedDbLedger } from '../ledger/indexeddb';
import { isOtcAsset } from './quotex/decoder';

const PAGE = 5_000; // TUNABLE: records per IndexedDB read; small enough to keep the tab responsive
const LINES_PER_CHUNK = 5_000; // TUNABLE: NDJSON lines per yielded chunk

export type ExportLedger = Pick<IndexedDbLedger, 'listRawFrames' | 'assetsIn' | 'candleSeries' | 'ticksPage' | 'candlesPage' | 'payoutsPage' | 'countRawFrames' | 'countTicks'>;

export interface Progress {
  done: number;
  total: number | null;
}

/** Raw frames, one RawFrameRecord per line, in seq order. */
export async function* rawFrameChunks(ledger: ExportLedger, onProgress?: (p: Progress) => void, page = PAGE): AsyncGenerator<string> {
  const total = await ledger.countRawFrames();
  let fromSeq: number | undefined;
  let done = 0;
  for (;;) {
    const rows = await ledger.listRawFrames({ fromSeq, limit: page });
    if (rows.length === 0) return;
    done += rows.length;
    onProgress?.({ done, total });
    yield rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    fromSeq = rows[rows.length - 1]!.seq + 1;
  }
}

interface Item {
  sortTs: number;
  kindOrder: number;
  asset: string;
  tf: string;
  ev: MarketEvent;
}

class PagedStream {
  private buf: Item[] = [];
  private i = 0;
  private after: number | null = null;
  private exhausted = false;

  constructor(private readonly fetch: (after: number | null) => Promise<{ items: Item[]; lastKey: number | null }>) {}

  get head(): Item | undefined {
    return this.buf[this.i];
  }

  async fill(): Promise<void> {
    // Feed candles are filtered out of a page, so a page can come back empty and not be the end.
    while (this.i >= this.buf.length && !this.exhausted) {
      const { items, lastKey } = await this.fetch(this.after);
      if (lastKey === null) this.exhausted = true;
      else this.after = lastKey;
      this.buf = items;
      this.i = 0;
    }
  }

  async advance(): Promise<void> {
    this.i++;
    if (this.i >= this.buf.length) await this.fill();
  }
}

function cmp(a: Item, b: Item): number {
  return a.sortTs - b.sortTs || a.kindOrder - b.kindOrder || (a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0) || (a.tf < b.tf ? -1 : a.tf > b.tf ? 1 : 0);
}

/**
 * The bbqx-dataset file: a DatasetMeta line, then tick, feed-candle and payout MarketEvents.
 * Rebuilt candles are left out (the harness rebuilds them from ticks), and so are payouts of
 * assets that have neither ticks nor feed candles.
 */
export async function* datasetChunks(ledger: ExportLedger, createdAt: number, onProgress?: (p: Progress) => void, page = PAGE): AsyncGenerator<string> {
  const tickAssets = await ledger.assetsIn('ticks');
  const series = await ledger.candleSeries();
  const payoutAssets = new Set(await ledger.assetsIn('payouts'));

  const candleAssets = new Set<string>();
  const isOTC = new Map<string, boolean>();
  const streams: PagedStream[] = [];

  for (const [asset, tf] of series) {
    let hasFeed = false;
    const stream = new PagedStream(async (after) => {
      const rows = await ledger.candlesPage(asset, tf, after, page);
      const items: Item[] = [];
      for (const c of rows) {
        if (c.source !== 'feed') continue;
        hasFeed = true;
        isOTC.set(asset, c.isOTC);
        const candle = { openTs: c.openTs, open: c.open, high: c.high, low: c.low, close: c.close, tickCount: c.tickCount };
        items.push({ sortTs: c.openTs + TF_MS[tf], kindOrder: 1, asset, tf, ev: { kind: 'candle', asset, isOTC: c.isOTC, tf, candle } });
      }
      return { items, lastKey: rows.length === 0 ? null : rows[rows.length - 1]!.openTs };
    });
    await stream.fill();
    if (hasFeed) {
      candleAssets.add(asset);
      streams.push(stream);
    }
  }

  const assets = [...new Set([...tickAssets, ...candleAssets])].sort();
  const otc = (a: string) => isOTC.get(a) ?? isOtcAsset(a);

  for (const asset of tickAssets) {
    streams.push(new PagedStream(async (after) => {
      const rows = await ledger.ticksPage(asset, after, page);
      return {
        items: rows.map((t) => ({ sortTs: t.ts, kindOrder: 0, asset, tf: '', ev: { kind: 'tick', asset, isOTC: otc(asset), ts: t.ts, price: t.price } })),
        lastKey: rows.length === 0 ? null : rows[rows.length - 1]!.ts,
      };
    }));
  }

  for (const asset of assets) {
    if (!payoutAssets.has(asset)) continue;
    streams.push(new PagedStream(async (after) => {
      const rows = await ledger.payoutsPage(asset, after, page);
      return {
        items: rows.map((p) => ({ sortTs: p.ts, kindOrder: 2, asset, tf: '', ev: { kind: 'payout', asset, isOTC: otc(asset), ts: p.ts, percent: p.percent } })),
        lastKey: rows.length === 0 ? null : rows[rows.length - 1]!.ts,
      };
    }));
  }

  // The meta line needs each asset's payout, so read the latest one before streaming events.
  const payoutPercent = new Map<string, number>();
  for (const asset of assets) {
    if (!payoutAssets.has(asset)) continue;
    let after: number | null = null;
    let last: number | undefined;
    for (;;) {
      const rows = await ledger.payoutsPage(asset, after, page);
      if (rows.length === 0) break;
      last = rows[rows.length - 1]!.percent;
      after = rows[rows.length - 1]!.ts;
    }
    if (last !== undefined) payoutPercent.set(asset, last);
  }
  const missing = assets.filter((a) => !payoutPercent.has(a));
  const sourceAssets: SourceAsset[] = assets.map((asset) => ({ asset, isOTC: otc(asset), payoutPercent: payoutPercent.get(asset) ?? 0 }));
  const notes = [
    'Exported from the Quorum extension ledger. Ticks cover only the ledger retention window (2 h); feed candles and payouts up to 30 d. Candle events are ordered by close time.',
  ];
  if (missing.length > 0) notes.push(`No payout recorded for: ${missing.join(', ')} (payoutPercent 0).`);
  const meta: DatasetMeta = { format: 'bbqx-dataset', version: 1, createdAt, assets: sourceAssets, note: notes.join(' ') };
  yield JSON.stringify(meta) + '\n';

  let total = 0;
  for (const a of tickAssets) total += await ledger.countTicks(a);
  for (const s of streams) await s.fill();
  let done = 0;
  let lines: string[] = [];
  for (;;) {
    let best: PagedStream | null = null;
    for (const s of streams) {
      const h = s.head;
      if (h && (!best || cmp(h, best.head!) < 0)) best = s;
    }
    if (!best) break;
    lines.push(JSON.stringify(best.head!.ev));
    if (best.head!.kindOrder === 0) done++;
    await best.advance();
    if (lines.length >= LINES_PER_CHUNK) {
      onProgress?.({ done, total });
      yield lines.join('\n') + '\n';
      lines = [];
    }
  }
  onProgress?.({ done, total });
  if (lines.length > 0) yield lines.join('\n') + '\n';
}

