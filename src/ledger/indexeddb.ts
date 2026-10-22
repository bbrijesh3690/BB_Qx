// IndexedDB implementation of the Ledger contract, used by the extension (service worker and
// export page share one database per extension origin). Behaviour must match src/ledger/memory.ts;
// the shared conformance suite (src/ledger/conformance.ts) is the referee.
//
// Ordering conventions (where the contract only says "oldest first"):
//   votes by (candleOpenTs, voteId); signals by (ts, signalId); events by (ts, seq);
//   patterns by (firstSeen, key); candles, ticks, payouts by their timestamp.
// export() returns every array in IndexedDB key order (numbers before strings, arrays compared
// element by element), which is what "sorted by store key" means for compound keys.

import { TUNABLES } from '../core/tunables';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import {
  LedgerConflictError,
  TF_MS,
  type CandleRecord,
  type EngineStateRecord,
  type EngineStatsRecord,
  type EventKind,
  type EventRecord,
  type FeedStructureRecord,
  type Ledger,
  type LedgerExport,
  type OutcomeRecord,
  type PatternRecord,
  type PayoutRecord,
  type RawFrameRecord,
  type ScoredVote,
  type SignalRecord,
  type TickRecord,
  type Timeframe,
  type TimeRange,
  type VoteQuery,
  type VoteRecord,
} from '../core/contracts';

const DB_VERSION = 1;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
// Retention from BB_Qx.md ("IndexedDB stores"), except ticks (see tunables.ts).
const TICK_RETENTION_MS = TUNABLES.retentionTicksMs.value; // TUNABLE: retentionTicksMs, shared with the in-memory ledger
const CANDLE_RETENTION_MS = 30 * DAY_MS;
const PAYOUT_RETENTION_MS = 30 * DAY_MS;
const FEED_STRUCTURE_RETENTION_MS = 30 * DAY_MS;

/** An array sorts after every number and string in IndexedDB key order, so [x, []] ends prefix x. */
// Typed as never so it fits any key slot; at runtime it is an empty array.
const AFTER = [] as unknown as never;

interface BbqxDb extends DBSchema {
  votes: {
    key: string;
    value: VoteRecord;
    indexes: {
      by_open: number;
      by_asset: [string, number];
      by_engine: [string, number];
      by_engine_asset: [string, string, number];
    };
  };
  outcomes: { key: string; value: OutcomeRecord };
  signals: { key: string; value: SignalRecord; indexes: { by_ts: number } };
  events: { key: number; value: EventRecord; indexes: { by_ts: number } };
  raw_frames: { key: number; value: RawFrameRecord; indexes: { by_tab: [number, number] } };
  candles: { key: [string, string, number]; value: CandleRecord };
  ticks: { key: [string, number]; value: TickRecord };
  payouts: { key: [string, number]; value: PayoutRecord };
  feed_structure: { key: [string, number]; value: FeedStructureRecord };
  patterns: { key: [string, string]; value: PatternRecord };
  engine_stats: { key: [string, string, number | string]; value: EngineStatsRecord };
  engine_state: { key: string; value: EngineStateRecord };
}

type AssetTsStore = 'ticks' | 'payouts' | 'feed_structure';

function upgrade(db: IDBPDatabase<BbqxDb>): void {
  const votes = db.createObjectStore('votes', { keyPath: 'voteId' });
  votes.createIndex('by_open', 'candleOpenTs');
  votes.createIndex('by_asset', ['asset', 'candleOpenTs']);
  votes.createIndex('by_engine', ['engine', 'candleOpenTs']);
  votes.createIndex('by_engine_asset', ['engine', 'asset', 'candleOpenTs']);
  db.createObjectStore('outcomes', { keyPath: 'voteId' });
  db.createObjectStore('signals', { keyPath: 'signalId' }).createIndex('by_ts', 'ts');
  db.createObjectStore('events', { keyPath: 'seq', autoIncrement: true }).createIndex('by_ts', 'ts');
  db.createObjectStore('raw_frames', { keyPath: 'seq', autoIncrement: true }).createIndex('by_tab', ['tabId', 'seq']);
  db.createObjectStore('candles', { keyPath: ['asset', 'tf', 'openTs'] });
  db.createObjectStore('ticks', { keyPath: ['asset', 'ts'] });
  db.createObjectStore('payouts', { keyPath: ['asset', 'ts'] });
  db.createObjectStore('feed_structure', { keyPath: ['asset', 'ts'] });
  db.createObjectStore('patterns', { keyPath: ['asset', 'key'] });
  db.createObjectStore('engine_stats', { keyPath: ['engine', 'asset', 'bucket'] });
  db.createObjectStore('engine_state', { keyPath: 'engine' });
}

export async function openIndexedDbLedger(name = 'bbqx'): Promise<IndexedDbLedger> {
  const db = await openDB<BbqxDb>(name, DB_VERSION, { upgrade: (d) => upgrade(d) });
  return new IndexedDbLedger(db);
}

/** [from, to) on a numeric key; null when empty (IDBKeyRange.bound throws on empty ranges). */
function tsRange(range?: TimeRange): { from: number; to: number } | null {
  const from = range?.fromTs ?? -Infinity;
  const to = range?.toTs ?? Infinity;
  return from < to ? { from, to } : null;
}

// Auto-increment injects seq as the last property; rebuild records in contract field order so
// JSON output does not depend on how the key was assigned.
function eventOut(e: EventRecord): EventRecord {
  return {
    seq: e.seq,
    ts: e.ts,
    kind: e.kind,
    ...(e.asset !== undefined && { asset: e.asset }),
    ...(e.engine !== undefined && { engine: e.engine }),
    payload: e.payload,
  };
}

function frameOut(f: RawFrameRecord): RawFrameRecord {
  return { seq: f.seq, receivedAt: f.receivedAt, tabId: f.tabId, socketUrl: f.socketUrl, dir: f.dir, encoding: f.encoding, data: f.data };
}

const byOpenThenId = (a: VoteRecord, b: VoteRecord) =>
  a.candleOpenTs - b.candleOpenTs || (a.voteId < b.voteId ? -1 : a.voteId > b.voteId ? 1 : 0);

/** Aggregates 1m candles of one 5m bucket. A 'feed' aggregate needs every part to come from the feed. */
export function aggregateCandles(openTs: number, tf: Timeframe, parts: CandleRecord[]): CandleRecord {
  const sorted = [...parts].sort((a, b) => a.openTs - b.openTs);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  return {
    asset: first.asset,
    isOTC: first.isOTC,
    tf,
    openTs,
    open: first.open,
    high: Math.max(...sorted.map((c) => c.high)),
    low: Math.min(...sorted.map((c) => c.low)),
    close: last.close,
    tickCount: sorted.reduce((n, c) => n + c.tickCount, 0),
    source: sorted.every((c) => c.source === 'feed') ? 'feed' : 'rebuilt',
  };
}

/** The contract's replacement rule: a 'rebuilt' candle never replaces a 'feed' one. */
export function candleMayReplace(existing: CandleRecord | undefined, next: CandleRecord): boolean {
  return !(existing?.source === 'feed' && next.source === 'rebuilt');
}

export class IndexedDbLedger implements Ledger {
  constructor(private readonly db: IDBPDatabase<BbqxDb>) {}

  close(): void {
    this.db.close();
  }

  // ---- append-only ----

  async appendVote(v: VoteRecord): Promise<void> {
    await this.appendUnique('votes', v.voteId, v);
  }

  async appendOutcome(o: OutcomeRecord): Promise<void> {
    await this.appendUnique('outcomes', o.voteId, o);
  }

  async appendSignal(s: SignalRecord): Promise<void> {
    await this.appendUnique('signals', s.signalId, s);
  }

  private async appendUnique<S extends 'votes' | 'outcomes' | 'signals'>(store: S, key: string, value: BbqxDb[S]['value']): Promise<void> {
    const tx = this.db.transaction(store, 'readwrite');
    // Checked first instead of relying on add()'s ConstraintError, which would abort the transaction.
    if ((await tx.store.getKey(key)) !== undefined) throw new LedgerConflictError(store, key);
    await tx.store.add(value);
    await tx.done;
  }

  async appendEvent(e: Omit<EventRecord, 'seq'>): Promise<number> {
    const tx = this.db.transaction('events', 'readwrite');
    const seq = await tx.store.add(e as EventRecord);
    await tx.done;
    return seq;
  }

  async appendRawFrames(frames: Omit<RawFrameRecord, 'seq'>[]): Promise<void> {
    if (frames.length === 0) return;
    const tx = this.db.transaction('raw_frames', 'readwrite');
    await Promise.all(frames.map((f) => tx.store.add(f as RawFrameRecord)));
    await tx.done;
  }

  // ---- idempotent ----

  async appendTicks(ticks: TickRecord[]): Promise<void> {
    if (ticks.length === 0) return;
    const seen = new Set<string>();
    const unique = ticks.filter((t) => {
      const k = `${t.asset}\u0000${t.ts}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const tx = this.db.transaction('ticks', 'readwrite');
    const existing = await Promise.all(unique.map((t) => tx.store.getKey([t.asset, t.ts])));
    await Promise.all(
      unique.map((t, i) => (existing[i] === undefined ? tx.store.add({ asset: t.asset, ts: t.ts, price: t.price }) : null)),
    );
    await tx.done;
  }

  async putCandle(c: CandleRecord): Promise<void> {
    const tx = this.db.transaction('candles', 'readwrite');
    const existing = await tx.store.get([c.asset, c.tf, c.openTs]);
    if (candleMayReplace(existing, c)) await tx.store.put(c);
    await tx.done;
  }

  async appendPayout(p: PayoutRecord): Promise<void> {
    await this.db.put('payouts', p);
  }

  async putFeedStructure(r: FeedStructureRecord): Promise<void> {
    await this.db.put('feed_structure', r);
  }

  async putPattern(r: PatternRecord): Promise<void> {
    await this.db.put('patterns', r);
  }

  async putEngineStats(r: EngineStatsRecord): Promise<void> {
    await this.db.put('engine_stats', r);
  }

  async putEngineState(r: EngineStateRecord): Promise<void> {
    await this.db.put('engine_state', r);
  }

  // ---- reads ----

  async queryVotes(q: VoteQuery): Promise<ScoredVote[]> {
    const r = tsRange(q);
    if (!r || (q.lastN !== undefined && q.lastN <= 0)) return [];
    const { from, to } = r;
    const tx = this.db.transaction(['votes', 'outcomes']);
    const votes = tx.objectStore('votes');
    let found: VoteRecord[];
    if (q.engine !== undefined && q.asset !== undefined) {
      found = await votes.index('by_engine_asset').getAll(IDBKeyRange.bound([q.engine, q.asset, from], [q.engine, q.asset, to], false, true));
    } else if (q.asset !== undefined) {
      found = await votes.index('by_asset').getAll(IDBKeyRange.bound([q.asset, from], [q.asset, to], false, true));
    } else if (q.engine !== undefined) {
      found = await votes.index('by_engine').getAll(IDBKeyRange.bound([q.engine, from], [q.engine, to], false, true));
    } else {
      found = await votes.index('by_open').getAll(IDBKeyRange.bound(from, to, false, true));
    }
    const candidates = found
      .filter((v) => (q.isOTC === undefined || v.isOTC === q.isOTC) && (q.tf === undefined || v.tf === q.tf) && (q.bucket === undefined || v.bucket === q.bucket))
      .sort(byOpenThenId);
    const outcomes = tx.objectStore('outcomes');
    const withOutcomes = async (vs: VoteRecord[]) => {
      const outs = await Promise.all(vs.map((v) => outcomes.get(v.voteId)));
      return vs.map((vote, i): ScoredVote => ({ vote, outcome: outs[i] ?? null }));
    };
    if (!q.scoredOnly) return withOutcomes(q.lastN !== undefined ? candidates.slice(-q.lastN) : candidates);

    // scoredOnly: walk back from the newest in chunks so lastN does not fetch every outcome.
    const want = q.lastN ?? Infinity;
    const chunk = Number.isFinite(want) ? Math.max(64, want) : Math.max(1, candidates.length);
    let result: ScoredVote[] = [];
    let end = candidates.length;
    while (end > 0 && result.length < want) {
      const start = Math.max(0, end - chunk);
      const scored = (await withOutcomes(candidates.slice(start, end))).filter((s) => s.outcome !== null);
      result = scored.concat(result);
      end = start;
    }
    return Number.isFinite(want) ? result.slice(-want) : result;
  }

  async getOutcome(voteId: string): Promise<OutcomeRecord | null> {
    return (await this.db.get('outcomes', voteId)) ?? null;
  }

  async getCandles(asset: string, tf: Timeframe, range?: TimeRange): Promise<CandleRecord[]> {
    const r = tsRange(range);
    if (!r) return [];
    return this.db.getAll('candles', IDBKeyRange.bound([asset, tf, r.from], [asset, tf, r.to], false, true));
  }

  async getTicks(asset: string, range?: TimeRange): Promise<TickRecord[]> {
    const r = tsRange(range);
    if (!r) return [];
    return this.db.getAll('ticks', IDBKeyRange.bound([asset, r.from], [asset, r.to], false, true));
  }

  async latestPayout(asset: string, atOrBeforeTs: number): Promise<PayoutRecord | null> {
    const cursor = await this.db
      .transaction('payouts')
      .store.openCursor(IDBKeyRange.bound([asset, -Infinity], [asset, atOrBeforeTs]), 'prev');
    return cursor?.value ?? null;
  }

  async listSignals(q: { asset?: string } & TimeRange): Promise<SignalRecord[]> {
    const r = tsRange(q);
    if (!r) return [];
    const all = await this.db.getAllFromIndex('signals', 'by_ts', IDBKeyRange.bound(r.from, r.to, false, true));
    return all
      .filter((s) => q.asset === undefined || s.asset === q.asset)
      .sort((a, b) => a.ts - b.ts || (a.signalId < b.signalId ? -1 : a.signalId > b.signalId ? 1 : 0));
  }

  async listEvents(q: { kind?: EventKind; asset?: string } & TimeRange): Promise<EventRecord[]> {
    const r = tsRange(q);
    if (!r) return [];
    const all = await this.db.getAllFromIndex('events', 'by_ts', IDBKeyRange.bound(r.from, r.to, false, true));
    return all
      .filter((e) => (q.kind === undefined || e.kind === q.kind) && (q.asset === undefined || e.asset === q.asset))
      .sort((a, b) => a.ts - b.ts || a.seq - b.seq)
      .map(eventOut);
  }

  async listPatterns(asset: string): Promise<PatternRecord[]> {
    const all = await this.db.getAll('patterns', IDBKeyRange.bound([asset], [asset, AFTER]));
    return all.sort((a, b) => a.firstSeen - b.firstSeen || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async getEngineStats(engine: string, asset: string, bucket: number | 'all'): Promise<EngineStatsRecord | null> {
    return (await this.db.get('engine_stats', [engine, asset, bucket])) ?? null;
  }

  async getEngineState(engine: string): Promise<EngineStateRecord | null> {
    return (await this.db.get('engine_state', engine)) ?? null;
  }

  async listRawFrames(q: { tabId?: number; fromSeq?: number; limit?: number }): Promise<RawFrameRecord[]> {
    // IndexedDB treats a count of 0 as "no limit".
    if (q.limit !== undefined && q.limit <= 0) return [];
    const from = q.fromSeq ?? -Infinity;
    const rows =
      q.tabId !== undefined
        ? await this.db.getAllFromIndex('raw_frames', 'by_tab', IDBKeyRange.bound([q.tabId, from], [q.tabId, Infinity]), q.limit)
        : await this.db.getAll('raw_frames', IDBKeyRange.lowerBound(from), q.limit);
    return rows.map(frameOut);
  }

  async countCandles(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const [asset, tf] of await this.candleSeries()) {
      out[`${asset}|${tf}`] = await this.db.count('candles', IDBKeyRange.bound([asset, tf], [asset, tf, AFTER]));
    }
    return out;
  }

  async listAssets(): Promise<{ asset: string; isOTC: boolean }[]> {
    const found = new Map<string, boolean>();
    const tx = this.db.transaction(['candles', 'votes']);
    let c = await tx.objectStore('candles').openCursor();
    while (c) {
      found.set(c.value.asset, c.value.isOTC);
      // The same array twice in one key is rejected as a cycle, so a 2-element key ends the prefix.
      c = await c.continue([c.value.asset, AFTER] as unknown as [string, string, number]);
    }
    let v = await tx.objectStore('votes').index('by_asset').openCursor();
    while (v) {
      if (!found.has(v.value.asset)) found.set(v.value.asset, v.value.isOTC);
      v = await v.continue([v.value.asset, AFTER]);
    }
    return [...found.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([asset, isOTC]) => ({ asset, isOTC }));
  }

  // ---- retention ----

  async prune(nowTs: number): Promise<void> {
    await this.deleteOlderThan('ticks', nowTs - TICK_RETENTION_MS);
    await this.deleteOlderThan('payouts', nowTs - PAYOUT_RETENTION_MS);
    await this.deleteOlderThan('feed_structure', nowTs - FEED_STRUCTURE_RETENTION_MS);
    await this.thinCandles(nowTs - CANDLE_RETENTION_MS);
  }

  private async deleteOlderThan(store: AssetTsStore, cutoff: number): Promise<void> {
    const tx = this.db.transaction(store, 'readwrite');
    let cursor = await tx.store.openKeyCursor();
    while (cursor) {
      const asset = cursor.key[0];
      await tx.store.delete(IDBKeyRange.bound([asset, -Infinity], [asset, cutoff], false, true));
      cursor = await cursor.continue([asset, AFTER]);
    }
    await tx.done;
  }

  /**
   * Replaces 1m candles older than `cutoff` by 5m aggregates. Only 5m buckets that end at or before
   * the cutoff are thinned, so a bucket is never aggregated from a partial set of its candles.
   */
  private async thinCandles(cutoff: number): Promise<void> {
    const bucketMs = TF_MS['5m'];
    const limit = Math.floor(cutoff / bucketMs) * bucketMs;
    const assets = (await this.candleSeries()).filter(([, tf]) => tf === '1m').map(([asset]) => asset);
    const tx = this.db.transaction('candles', 'readwrite');
    for (const asset of assets) {
      const range = IDBKeyRange.bound([asset, '1m', -Infinity], [asset, '1m', limit], false, true);
      const old = await tx.store.getAll(range);
      if (old.length === 0) continue;
      const buckets = new Map<number, CandleRecord[]>();
      for (const c of old) {
        const b = Math.floor(c.openTs / bucketMs) * bucketMs;
        const list = buckets.get(b);
        if (list) list.push(c);
        else buckets.set(b, [c]);
      }
      for (const [openTs, parts] of buckets) {
        const agg = aggregateCandles(openTs, '5m', parts);
        const existing = await tx.store.get([asset, '5m', openTs]);
        if (candleMayReplace(existing, agg)) await tx.store.put(agg);
      }
      await tx.store.delete(range);
    }
    await tx.done;
  }

  // ---- export ----

  async export(opts?: { includeTicks?: boolean }): Promise<LedgerExport> {
    const tx = this.db.transaction(['votes', 'outcomes', 'signals', 'events', 'candles', 'payouts', 'feed_structure', 'patterns', 'engine_stats', 'ticks']);
    const out: LedgerExport = {
      format: 'bbqx-ledger',
      version: 1,
      votes: await tx.objectStore('votes').getAll(),
      outcomes: await tx.objectStore('outcomes').getAll(),
      signals: await tx.objectStore('signals').getAll(),
      events: (await tx.objectStore('events').getAll()).map(eventOut),
      candles: await tx.objectStore('candles').getAll(),
      payouts: await tx.objectStore('payouts').getAll(),
      feedStructure: await tx.objectStore('feed_structure').getAll(),
      patterns: await tx.objectStore('patterns').getAll(),
      engineStats: await tx.objectStore('engine_stats').getAll(),
    };
    if (opts?.includeTicks) out.ticks = await tx.objectStore('ticks').getAll();
    return out;
  }

  // ---- extension helpers (not part of the Ledger contract) ----

  async countRawFrames(): Promise<number> {
    return this.db.count('raw_frames');
  }

  /** Deletes every stored raw frame and returns how many there were. */
  async clearRawFrames(): Promise<number> {
    const n = await this.db.count('raw_frames');
    await this.db.clear('raw_frames');
    return n;
  }

  async countTicks(asset: string): Promise<number> {
    return this.db.count('ticks', IDBKeyRange.bound([asset], [asset, AFTER]));
  }

  async lastTick(asset: string): Promise<TickRecord | null> {
    const cursor = await this.db.transaction('ticks').store.openCursor(IDBKeyRange.bound([asset], [asset, AFTER]), 'prev');
    return cursor?.value ?? null;
  }

  /** The newest `n` candles of a series, oldest first. */
  async lastCandles(asset: string, tf: Timeframe, n: number): Promise<CandleRecord[]> {
    const out: CandleRecord[] = [];
    if (n <= 0) return out;
    let cursor = await this.db.transaction('candles').store.openCursor(IDBKeyRange.bound([asset, tf], [asset, tf, AFTER]), 'prev');
    while (cursor && out.length < n) {
      out.push(cursor.value);
      cursor = await cursor.continue();
    }
    return out.reverse();
  }

  /** Every (asset, tf) pair that has candles, in key order. */
  async candleSeries(): Promise<[string, Timeframe][]> {
    const out: [string, Timeframe][] = [];
    const tx = this.db.transaction('candles');
    let cursor = await tx.store.openKeyCursor();
    while (cursor) {
      const [asset, tf] = cursor.key;
      out.push([asset, tf as Timeframe]);
      cursor = await cursor.continue([asset, tf, AFTER]);
    }
    return out;
  }

  /** Assets that have at least one record in an (asset, ts) store, in key order. */
  async assetsIn(store: AssetTsStore): Promise<string[]> {
    const out: string[] = [];
    const tx = this.db.transaction(store);
    let cursor = await tx.store.openKeyCursor();
    while (cursor) {
      out.push(cursor.key[0]);
      cursor = await cursor.continue([cursor.key[0], AFTER]);
    }
    return out;
  }

  /** Paging for exports: up to `limit` records strictly after `afterTs` (or from the start). */
  async ticksPage(asset: string, afterTs: number | null, limit: number): Promise<TickRecord[]> {
    return this.db.getAll('ticks', IDBKeyRange.bound([asset, afterTs ?? -Infinity], [asset, Infinity], afterTs !== null, false), limit);
  }

  async payoutsPage(asset: string, afterTs: number | null, limit: number): Promise<PayoutRecord[]> {
    return this.db.getAll('payouts', IDBKeyRange.bound([asset, afterTs ?? -Infinity], [asset, Infinity], afterTs !== null, false), limit);
  }

  async candlesPage(asset: string, tf: Timeframe, afterOpenTs: number | null, limit: number): Promise<CandleRecord[]> {
    return this.db.getAll(
      'candles',
      IDBKeyRange.bound([asset, tf, afterOpenTs ?? -Infinity], [asset, tf, Infinity], afterOpenTs !== null, false),
      limit,
    );
  }
}
