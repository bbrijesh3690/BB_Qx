// In-memory Ledger for the harness and tests. Behaviourally identical to the IndexedDB ledger
// (src/ledger/conformance.ts is the shared suite). Deterministic: no clocks, no randomness.
// Records are copied on the way in and on the way out, as IndexedDB's structured clone would.

import {
  LedgerConflictError, TF_MS,
  type CandleRecord, type EngineStateRecord, type EngineStatsRecord, type EventKind, type EventRecord,
  type FeedStructureRecord, type Ledger, type LedgerExport, type OutcomeRecord, type PatternRecord,
  type PayoutRecord, type RawFrameRecord, type ScoredVote, type SignalRecord, type TickRecord, type Timeframe,
  type TimeRange, type VoteQuery, type VoteRecord,
} from '../core/contracts';
import { openTsOf } from '../core/time';
import { TUNABLES } from '../core/tunables';

type KeyPart = number | string;

/** IndexedDB key order: numbers before strings, strings by UTF-16 code unit, arrays element by element. */
export function compareKeys(a: readonly KeyPart[], b: readonly KeyPart[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!, y = b[i]!;
    if (typeof x !== typeof y) return typeof x === 'number' ? -1 : 1;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return a.length - b.length;
}

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const inRange = (ts: number, r: TimeRange | undefined) =>
  (r?.fromTs === undefined || ts >= r.fromTs) && (r?.toTs === undefined || ts < r.toTs);
const SEP = '\u0000';

// ---------------------------------------------------------------------------
// Copies with a fixed field order, so exports compare byte for byte
// ---------------------------------------------------------------------------

function copyVote(v: VoteRecord): VoteRecord {
  const head = {
    voteId: v.voteId, ts: v.ts, asset: v.asset, isOTC: v.isOTC, tf: v.tf, candleOpenTs: v.candleOpenTs,
    bucket: v.bucket, engine: v.engine, direction: v.direction, confidence: v.confidence, reasons: v.reasons.slice(),
  };
  return v.features === undefined
    ? { ...head, payoutAtVote: v.payoutAtVote, frozenAt: v.frozenAt }
    : { ...head, features: { ...v.features }, payoutAtVote: v.payoutAtVote, frozenAt: v.frozenAt };
}

function copyOutcome(o: OutcomeRecord): OutcomeRecord {
  return { voteId: o.voteId, result: o.result, openPrice: o.openPrice, closePrice: o.closePrice, scoredAt: o.scoredAt };
}

function copyCandle(c: CandleRecord): CandleRecord {
  return {
    asset: c.asset, isOTC: c.isOTC, tf: c.tf, openTs: c.openTs, open: c.open, high: c.high, low: c.low,
    close: c.close, tickCount: c.tickCount, source: c.source,
  };
}

function copyEvent(e: EventRecord): EventRecord {
  const out: EventRecord = { seq: e.seq, ts: e.ts, kind: e.kind, payload: structuredClone(e.payload) };
  if (e.asset !== undefined) out.asset = e.asset;
  if (e.engine !== undefined) out.engine = e.engine;
  return out;
}

const clone = <T>(x: T): T => structuredClone(x);

// ---------------------------------------------------------------------------
// Sorted numeric series (ticks): parallel arrays, ascending ts
// ---------------------------------------------------------------------------

interface TickSeries { ts: number[]; price: number[] }

/** Index of the first element >= ts. */
function lowerBound(arr: readonly number[], ts: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < ts) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export class MemoryLedger implements Ledger {
  private readonly votes = new Map<string, VoteRecord>();
  /** Votes ordered by (candleOpenTs, voteId): the order queryVotes returns. */
  private readonly voteOrder: VoteRecord[] = [];
  private readonly outcomes = new Map<string, OutcomeRecord>();
  private readonly signals = new Map<string, SignalRecord>();
  private readonly events: EventRecord[] = [];
  private eventSeq = 0;
  private readonly rawFrames: RawFrameRecord[] = [];
  private rawSeq = 0;
  private readonly ticks = new Map<string, TickSeries>();
  private readonly candles = new Map<string, Map<number, CandleRecord>>(); // `${asset}\0${tf}` -> openTs -> candle
  private readonly payouts = new Map<string, Map<number, PayoutRecord>>();
  private readonly feedStructure = new Map<string, Map<number, FeedStructureRecord>>();
  private readonly patterns = new Map<string, Map<string, PatternRecord>>();
  private readonly engineStats = new Map<string, EngineStatsRecord>();
  private readonly engineState = new Map<string, EngineStateRecord>();
  private readonly assets = new Map<string, boolean>();

  // --- append-only -----------------------------------------------------------

  async appendVote(v: VoteRecord): Promise<void> {
    if (this.votes.has(v.voteId)) throw new LedgerConflictError('votes', v.voteId);
    const rec = copyVote(v);
    this.votes.set(rec.voteId, rec);
    const order = this.voteOrder;
    let i = order.length;
    while (i > 0 && compareVoteOrder(order[i - 1]!, rec) > 0) i--;
    if (i === order.length) order.push(rec); else order.splice(i, 0, rec);
    if (!this.assets.has(rec.asset)) this.assets.set(rec.asset, rec.isOTC);
  }

  async appendOutcome(o: OutcomeRecord): Promise<void> {
    if (this.outcomes.has(o.voteId)) throw new LedgerConflictError('outcomes', o.voteId);
    this.outcomes.set(o.voteId, copyOutcome(o));
  }

  async appendSignal(s: SignalRecord): Promise<void> {
    if (this.signals.has(s.signalId)) throw new LedgerConflictError('signals', s.signalId);
    this.signals.set(s.signalId, clone(s));
  }

  async appendEvent(e: Omit<EventRecord, 'seq'>): Promise<number> {
    const seq = ++this.eventSeq;
    this.events.push(copyEvent({ ...e, seq }));
    return seq;
  }

  async appendRawFrames(frames: Omit<RawFrameRecord, 'seq'>[]): Promise<void> {
    for (const f of frames) {
      this.rawFrames.push({
        seq: ++this.rawSeq, receivedAt: f.receivedAt, tabId: f.tabId, socketUrl: f.socketUrl, dir: f.dir,
        encoding: f.encoding, data: f.data,
      });
    }
  }

  // --- idempotent writes -----------------------------------------------------

  async appendTicks(ticks: TickRecord[]): Promise<void> {
    for (const t of ticks) {
      let s = this.ticks.get(t.asset);
      if (!s) this.ticks.set(t.asset, (s = { ts: [], price: [] }));
      const n = s.ts.length;
      if (n === 0 || t.ts > s.ts[n - 1]!) {
        s.ts.push(t.ts);
        s.price.push(t.price);
        continue;
      }
      const i = lowerBound(s.ts, t.ts);
      if (s.ts[i] === t.ts) continue; // existing asset+ts wins
      s.ts.splice(i, 0, t.ts);
      s.price.splice(i, 0, t.price);
    }
  }

  async putCandle(c: CandleRecord): Promise<void> {
    const key = c.asset + SEP + c.tf;
    let series = this.candles.get(key);
    if (!series) this.candles.set(key, (series = new Map()));
    const existing = series.get(c.openTs);
    if (existing && existing.source === 'feed' && c.source === 'rebuilt') return;
    series.set(c.openTs, copyCandle(c));
    if (!this.assets.has(c.asset)) this.assets.set(c.asset, c.isOTC);
  }

  async appendPayout(p: PayoutRecord): Promise<void> {
    let m = this.payouts.get(p.asset);
    if (!m) this.payouts.set(p.asset, (m = new Map()));
    if (!m.has(p.ts)) m.set(p.ts, { asset: p.asset, ts: p.ts, percent: p.percent });
  }

  async putFeedStructure(r: FeedStructureRecord): Promise<void> {
    let m = this.feedStructure.get(r.asset);
    if (!m) this.feedStructure.set(r.asset, (m = new Map()));
    m.set(r.ts, clone(r));
  }

  async putPattern(r: PatternRecord): Promise<void> {
    let m = this.patterns.get(r.asset);
    if (!m) this.patterns.set(r.asset, (m = new Map()));
    m.set(r.key, clone(r));
  }

  async putEngineStats(r: EngineStatsRecord): Promise<void> {
    this.engineStats.set(statsKey(r.engine, r.asset, r.bucket), clone(r));
  }

  async putEngineState(r: EngineStateRecord): Promise<void> {
    this.engineState.set(r.engine, clone(r));
  }

  // --- reads -------------------------------------------------------------------

  async queryVotes(q: VoteQuery): Promise<ScoredVote[]> {
    const match = (v: VoteRecord) =>
      (q.engine === undefined || v.engine === q.engine) &&
      (q.asset === undefined || v.asset === q.asset) &&
      (q.isOTC === undefined || v.isOTC === q.isOTC) &&
      (q.tf === undefined || v.tf === q.tf) &&
      (q.bucket === undefined || v.bucket === q.bucket) &&
      (q.fromTs === undefined || v.candleOpenTs >= q.fromTs) &&
      (q.toTs === undefined || v.candleOpenTs < q.toTs) &&
      (!q.scoredOnly || this.outcomes.has(v.voteId));
    let picked: VoteRecord[];
    if (q.lastN === undefined) {
      picked = this.voteOrder.filter(match);
    } else {
      picked = [];
      for (let i = this.voteOrder.length - 1; i >= 0 && picked.length < q.lastN; i--) {
        const v = this.voteOrder[i]!;
        if (match(v)) picked.push(v);
      }
      picked.reverse();
    }
    return picked.map((v) => {
      const o = this.outcomes.get(v.voteId);
      return { vote: copyVote(v), outcome: o ? copyOutcome(o) : null };
    });
  }

  async getOutcome(voteId: string): Promise<OutcomeRecord | null> {
    const o = this.outcomes.get(voteId);
    return o ? copyOutcome(o) : null;
  }

  async getCandles(asset: string, tf: Timeframe, range?: TimeRange): Promise<CandleRecord[]> {
    const series = this.candles.get(asset + SEP + tf);
    if (!series) return [];
    return [...series.values()]
      .filter((c) => inRange(c.openTs, range))
      .sort((a, b) => a.openTs - b.openTs)
      .map(copyCandle);
  }

  async getTicks(asset: string, range?: TimeRange): Promise<TickRecord[]> {
    const s = this.ticks.get(asset);
    if (!s) return [];
    const from = range?.fromTs === undefined ? 0 : lowerBound(s.ts, range.fromTs);
    const to = range?.toTs === undefined ? s.ts.length : lowerBound(s.ts, range.toTs);
    const out: TickRecord[] = [];
    for (let i = from; i < to; i++) out.push({ asset, ts: s.ts[i]!, price: s.price[i]! });
    return out;
  }

  async latestPayout(asset: string, atOrBeforeTs: number): Promise<PayoutRecord | null> {
    const m = this.payouts.get(asset);
    let best: PayoutRecord | null = null;
    if (m) for (const p of m.values()) if (p.ts <= atOrBeforeTs && (!best || p.ts > best.ts)) best = p;
    return best ? { asset: best.asset, ts: best.ts, percent: best.percent } : null;
  }

  async listSignals(q: { asset?: string } & TimeRange): Promise<SignalRecord[]> {
    return [...this.signals.values()]
      .filter((s) => (q.asset === undefined || s.asset === q.asset) && inRange(s.ts, q))
      .sort((a, b) => a.ts - b.ts || cmpStr(a.signalId, b.signalId))
      .map(clone);
  }

  async listEvents(q: { kind?: EventKind; asset?: string } & TimeRange): Promise<EventRecord[]> {
    return this.events
      .filter((e) => (q.kind === undefined || e.kind === q.kind) && (q.asset === undefined || e.asset === q.asset) && inRange(e.ts, q))
      .map(copyEvent);
  }

  async listPatterns(asset: string): Promise<PatternRecord[]> {
    const m = this.patterns.get(asset);
    if (!m) return [];
    return [...m.values()].sort((a, b) => cmpStr(a.key, b.key)).map(clone);
  }

  async getEngineStats(engine: string, asset: string, bucket: number | 'all'): Promise<EngineStatsRecord | null> {
    const r = this.engineStats.get(statsKey(engine, asset, bucket));
    return r ? clone(r) : null;
  }

  async getEngineState(engine: string): Promise<EngineStateRecord | null> {
    const r = this.engineState.get(engine);
    return r ? clone(r) : null;
  }

  async listRawFrames(q: { tabId?: number; fromSeq?: number; limit?: number }): Promise<RawFrameRecord[]> {
    const out: RawFrameRecord[] = [];
    for (const f of this.rawFrames) {
      if (q.limit !== undefined && out.length >= q.limit) break;
      if (q.fromSeq !== undefined && f.seq < q.fromSeq) continue;
      if (q.tabId !== undefined && f.tabId !== q.tabId) continue;
      out.push({ ...f });
    }
    return out;
  }

  async countCandles(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const key of [...this.candles.keys()].sort()) {
      const series = this.candles.get(key)!;
      if (series.size === 0) continue;
      const [asset, tf] = key.split(SEP) as [string, string];
      out[`${asset}|${tf}`] = series.size;
    }
    return out;
  }

  async listAssets(): Promise<{ asset: string; isOTC: boolean }[]> {
    return [...this.assets.entries()]
      .sort((a, b) => cmpStr(a[0], b[0]))
      .map(([asset, isOTC]) => ({ asset, isOTC }));
  }

  // --- retention ---------------------------------------------------------------

  async prune(nowTs: number): Promise<void> {
    const tickCut = nowTs - TUNABLES.retentionTicksMs.value; // TUNABLE: retentionTicksMs
    for (const s of this.ticks.values()) {
      const i = lowerBound(s.ts, tickCut);
      if (i > 0) { s.ts.splice(0, i); s.price.splice(0, i); }
    }

    const candleCut = nowTs - TUNABLES.retentionCandlesMs.value; // TUNABLE: retentionCandlesMs
    for (const [key, series] of [...this.candles]) {
      if (!key.endsWith(SEP + '1m')) continue;
      const groups = new Map<number, CandleRecord[]>();
      for (const c of series.values()) {
        const bucket = openTsOf(c.openTs, '5m');
        if (bucket + TF_MS['5m'] > candleCut) continue; // only whole 5m windows past the cut
        let g = groups.get(bucket);
        if (!g) groups.set(bucket, (g = []));
        g.push(c);
      }
      for (const [bucket, group] of groups) {
        for (const c of group) series.delete(c.openTs);
        group.sort((a, b) => a.openTs - b.openTs);
        const first = group[0]!;
        const fiveKey = first.asset + SEP + '5m';
        let five = this.candles.get(fiveKey);
        if (!five) this.candles.set(fiveKey, (five = new Map()));
        if (five.has(bucket)) continue; // an existing 5m candle was built from fuller data
        five.set(bucket, aggregate(group, bucket));
      }
    }

    const payoutCut = nowTs - TUNABLES.retentionPayoutsMs.value; // TUNABLE: retentionPayoutsMs
    for (const m of this.payouts.values()) for (const ts of [...m.keys()]) if (ts < payoutCut) m.delete(ts);
    for (const m of this.feedStructure.values()) for (const ts of [...m.keys()]) if (ts < payoutCut) m.delete(ts);
  }

  // --- export ------------------------------------------------------------------

  async export(opts?: { includeTicks?: boolean }): Promise<LedgerExport> {
    const byStr = <T>(key: (x: T) => string) => (a: T, b: T) => cmpStr(key(a), key(b));
    const out: LedgerExport = {
      format: 'bbqx-ledger',
      version: 1,
      votes: [...this.votes.values()].sort(byStr((v) => v.voteId)).map(copyVote),
      outcomes: [...this.outcomes.values()].sort(byStr((o) => o.voteId)).map(copyOutcome),
      signals: [...this.signals.values()].sort(byStr((s) => s.signalId)).map(clone),
      events: this.events.map(copyEvent),
      candles: [...this.candles.values()].flatMap((m) => [...m.values()])
        .sort((a, b) => compareKeys([a.asset, a.tf, a.openTs], [b.asset, b.tf, b.openTs])).map(copyCandle),
      payouts: [...this.payouts.values()].flatMap((m) => [...m.values()])
        .sort((a, b) => compareKeys([a.asset, a.ts], [b.asset, b.ts])).map((p) => ({ asset: p.asset, ts: p.ts, percent: p.percent })),
      feedStructure: [...this.feedStructure.values()].flatMap((m) => [...m.values()])
        .sort((a, b) => compareKeys([a.asset, a.ts], [b.asset, b.ts])).map(clone),
      patterns: [...this.patterns.values()].flatMap((m) => [...m.values()])
        .sort((a, b) => compareKeys([a.asset, a.key], [b.asset, b.key])).map(clone),
      engineStats: [...this.engineStats.values()]
        .sort((a, b) => compareKeys([a.engine, a.asset, a.bucket], [b.engine, b.asset, b.bucket])).map(clone),
    };
    if (opts?.includeTicks) {
      const ticks: TickRecord[] = [];
      for (const asset of [...this.ticks.keys()].sort(cmpStr)) {
        const s = this.ticks.get(asset)!;
        for (let i = 0; i < s.ts.length; i++) ticks.push({ asset, ts: s.ts[i]!, price: s.price[i]! });
      }
      out.ticks = ticks;
    }
    return out;
  }
}

function compareVoteOrder(a: VoteRecord, b: VoteRecord): number {
  return a.candleOpenTs - b.candleOpenTs || cmpStr(a.voteId, b.voteId);
}

function statsKey(engine: string, asset: string, bucket: number | 'all'): string {
  return engine + SEP + asset + SEP + (typeof bucket === 'number' ? `n${bucket}` : `s${bucket}`);
}

/** One 5m candle from the 1m candles of its window, oldest first. */
function aggregate(group: readonly CandleRecord[], openTs: number): CandleRecord {
  const first = group[0]!, last = group[group.length - 1]!;
  let high = -Infinity, low = Infinity, tickCount = 0;
  for (const c of group) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
    tickCount += c.tickCount;
  }
  return {
    asset: first.asset, isOTC: first.isOTC, tf: '5m', openTs, open: first.open, high, low, close: last.close, tickCount,
    source: group.every((c) => c.source === 'feed') ? 'feed' : 'rebuilt',
  };
}
