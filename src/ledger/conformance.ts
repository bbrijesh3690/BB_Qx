// Shared behaviour suite for every Ledger implementation (in-memory and IndexedDB).
// It tests only through the Ledger interface, so the lead can run it against any implementation:
//
//   ledgerConformance('memory', async () => new MemoryLedger());
//
// Where the contract leaves a detail open (for example whether signal ranges apply to ts or
// candleOpenTs), the fixtures are chosen so that every reasonable reading gives the same answer.

import { describe, expect, it } from 'vitest';
import {
  bucketOf, LedgerConflictError, signalIdOf, voteIdOf,
  type CandleRecord, type EngineStatsRecord, type EventRecord, type FeedStructureRecord, type Ledger,
  type LedgerExport, type OutcomeRecord, type PatternRecord, type SignalRecord, type Timeframe, type VoteRecord,
} from '../core/contracts';
import { TUNABLES } from '../core/tunables';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Monday 2026-01-05 10:00 UTC. */
const T0 = Date.UTC(2026, 0, 5, 10, 0);

type VoteInit = Partial<VoteRecord> & { asset?: string; tf?: Timeframe; candleOpenTs?: number; engine?: string };

function vote(init: VoteInit = {}): VoteRecord {
  const asset = init.asset ?? 'EURUSD_otc';
  const tf = init.tf ?? '1m';
  const candleOpenTs = init.candleOpenTs ?? T0;
  const engine = init.engine ?? 'null';
  return {
    voteId: voteIdOf(asset, tf, candleOpenTs, engine),
    ts: candleOpenTs - 5000,
    asset, isOTC: asset.endsWith('_otc'), tf, candleOpenTs, bucket: bucketOf(candleOpenTs),
    engine, direction: 'UP', confidence: 0.6, reasons: ['test'],
    payoutAtVote: 0.85, frozenAt: candleOpenTs - 5000,
    ...init,
  };
}

function outcome(v: VoteRecord, result: OutcomeRecord['result'] = 'WIN'): OutcomeRecord {
  return { voteId: v.voteId, result, openPrice: 1.1, closePrice: result === 'TIE' ? 1.1 : 1.1001, scoredAt: v.candleOpenTs + MIN + 2000 };
}

function candle(init: Partial<CandleRecord> = {}): CandleRecord {
  const asset = init.asset ?? 'EURUSD_otc';
  return {
    asset, isOTC: asset.endsWith('_otc'), tf: '1m', openTs: T0,
    open: 1.1, high: 1.1003, low: 1.0998, close: 1.1001, tickCount: 12, source: 'rebuilt',
    ...init,
  };
}

function signal(init: Partial<SignalRecord> = {}): SignalRecord {
  const asset = init.asset ?? 'EURUSD_otc';
  const candleOpenTs = init.candleOpenTs ?? T0;
  return {
    signalId: signalIdOf(asset, '1m', candleOpenTs),
    ts: candleOpenTs - 5000,
    asset, isOTC: asset.endsWith('_otc'), tf: '1m', candleOpenTs, bucket: bucketOf(candleOpenTs),
    p: 0.6, threshold: 0.561, direction: 'UP', stakeShadow: { flat: 1, quarterKelly: 0.5 },
    gateFlags: { gatekeeper: 1 }, engineWeights: { priceAction: 0.4, null: 0 },
    ...init,
  };
}

function feedStructure(asset: string, ts: number): FeedStructureRecord {
  return { asset, ts, label: 'mean-reverting', strength: 0.3, autocorr: [-0.04, 0, 0, 0, 0], varianceRatio: 0.9, runsZ: 1.2, streakReversalRate: 0.53 };
}

function pattern(asset: string, key: string, init: Partial<PatternRecord> = {}): PatternRecord {
  return {
    asset, key, status: 'candidate', occurrences: 40, winsA: 22, winsB: 0, days: 2,
    firstSeen: T0, lastSeen: T0 + HOUR, validatedAt: null, expiredAt: null, ...init,
  };
}

function stats(engine: string, asset: string, bucket: number | 'all', votes = 10): EngineStatsRecord {
  return { engine, asset, bucket, votes, abstains: 1, hits: 5, ties: 0, last100: null, last200: null, brier: 0.25, killed: false };
}

/** Deterministic shuffle so write order differs from key order. */
function shuffled<T>(xs: readonly T[], salt = 1): T[] {
  const out = xs.slice();
  let s = (0x9e3779b9 * salt) >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const ids = (rows: { vote: VoteRecord }[]) => rows.map((r) => r.vote.voteId);

/** A spread of votes: 2 engines x 2 assets (OTC and live) x 2 timeframes x 6 candles over 3 hours. */
function voteFixture(): VoteRecord[] {
  const out: VoteRecord[] = [];
  for (const engine of ['null', 'priceAction'])
    for (const asset of ['EURUSD_otc', 'GBPUSD'])
      for (const tf of ['1m', '5m'] as const)
        for (let i = 0; i < 6; i++) out.push(vote({ engine, asset, tf, candleOpenTs: T0 + i * 30 * MIN, direction: i % 3 === 2 ? 'ABSTAIN' : 'UP' }));
  return out;
}

/** Expected queryVotes order: candleOpenTs, then voteId (UTF-16 code units). */
function expectedOrder(vs: readonly VoteRecord[]): string[] {
  return vs.slice()
    .sort((a, b) => a.candleOpenTs - b.candleOpenTs || (a.voteId < b.voteId ? -1 : a.voteId > b.voteId ? 1 : 0))
    .map((v) => v.voteId);
}

async function loadFixture(l: Ledger): Promise<{ votes: VoteRecord[]; scored: Set<string> }> {
  const votes = voteFixture();
  for (const v of shuffled(votes)) await l.appendVote(v);
  const scored = new Set<string>();
  for (const v of votes) {
    if (v.direction !== 'ABSTAIN' && v.candleOpenTs < T0 + 120 * MIN) {
      await l.appendOutcome(outcome(v, v.candleOpenTs === T0 ? 'TIE' : 'WIN'));
      scored.add(v.voteId);
    }
  }
  return { votes, scored };
}

function isSortedBy<T>(xs: readonly T[], cmp: (a: T, b: T) => number): boolean {
  for (let i = 1; i < xs.length; i++) if (cmp(xs[i - 1]!, xs[i]!) > 0) return false;
  return true;
}
const cmpS = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const cmpN = (a: number, b: number) => a - b;
const cmpBucket = (a: number | 'all', b: number | 'all') =>
  typeof a === typeof b ? (typeof a === 'number' ? a - (b as number) : cmpS(a as string, b as string)) : typeof a === 'number' ? -1 : 1;

export function ledgerConformance(name: string, make: () => Promise<Ledger>): void {
  describe(`Ledger conformance: ${name}`, () => {
    // -------------------------------------------------------------------------
    describe('votes and outcomes', () => {
      it('appendVote stores a vote that queryVotes returns unchanged, with a null outcome', async () => {
        const l = await make();
        const v = vote();
        await l.appendVote(v);
        expect(await l.queryVotes({})).toEqual([{ vote: v, outcome: null }]);
      });

      it('features are optional and round-trip when present', async () => {
        const l = await make();
        const a = vote({ engine: 'a' });
        const b = vote({ engine: 'b', features: { rsi: 61.5, bandPos: -0.4 } });
        await l.appendVote(a);
        await l.appendVote(b);
        const rows = await l.queryVotes({});
        expect(rows.find((r) => r.vote.engine === 'a')!.vote.features).toBeUndefined();
        expect(rows.find((r) => r.vote.engine === 'b')!.vote.features).toEqual({ rsi: 61.5, bandPos: -0.4 });
      });

      it('appendVote rejects an existing voteId with LedgerConflictError and keeps the original', async () => {
        const l = await make();
        const v = vote();
        await l.appendVote(v);
        await expect(l.appendVote({ ...v, direction: 'DOWN' })).rejects.toBeInstanceOf(LedgerConflictError);
        const rows = await l.queryVotes({});
        expect(rows).toHaveLength(1);
        expect(rows[0]!.vote.direction).toBe('UP');
      });

      it('appendOutcome stores an outcome; getOutcome returns it, or null when absent', async () => {
        const l = await make();
        const v = vote();
        await l.appendVote(v);
        expect(await l.getOutcome(v.voteId)).toBeNull();
        const o = outcome(v, 'LOSS');
        await l.appendOutcome(o);
        expect(await l.getOutcome(v.voteId)).toEqual(o);
        expect(await l.getOutcome('nope')).toBeNull();
        expect(await l.queryVotes({})).toEqual([{ vote: v, outcome: o }]);
      });

      it('appendOutcome rejects an existing voteId with LedgerConflictError and keeps the original', async () => {
        const l = await make();
        const v = vote();
        await l.appendVote(v);
        await l.appendOutcome(outcome(v, 'WIN'));
        await expect(l.appendOutcome(outcome(v, 'LOSS'))).rejects.toBeInstanceOf(LedgerConflictError);
        expect((await l.getOutcome(v.voteId))!.result).toBe('WIN');
      });

      it('stores copies: mutating an input after writing, or a result after reading, changes nothing', async () => {
        const l = await make();
        const v = vote({ features: { x: 1 } });
        await l.appendVote(v);
        v.reasons.push('mutated');
        v.features!.x = 2;
        v.direction = 'DOWN';
        const first = await l.queryVotes({});
        expect(first[0]!.vote.reasons).toEqual(['test']);
        expect(first[0]!.vote.features).toEqual({ x: 1 });
        expect(first[0]!.vote.direction).toBe('UP');
        first[0]!.vote.reasons.push('mutated again');
        expect((await l.queryVotes({}))[0]!.vote.reasons).toEqual(['test']);
      });
    });

    // -------------------------------------------------------------------------
    describe('queryVotes', () => {
      it('returns every vote oldest first by candleOpenTs, ties broken by voteId', async () => {
        const l = await make();
        const { votes } = await loadFixture(l);
        expect(ids(await l.queryVotes({}))).toEqual(expectedOrder(votes));
      });

      it('attaches the outcome when there is one and null otherwise', async () => {
        const l = await make();
        const { votes, scored } = await loadFixture(l);
        const rows = await l.queryVotes({});
        expect(rows).toHaveLength(votes.length);
        for (const r of rows) {
          if (scored.has(r.vote.voteId)) expect(r.outcome?.voteId).toBe(r.vote.voteId);
          else expect(r.outcome).toBeNull();
        }
        expect(rows.filter((r) => r.outcome?.result === 'TIE').length).toBeGreaterThan(0);
      });

      it('filters by engine, asset, isOTC, tf and bucket', async () => {
        const l = await make();
        const { votes } = await loadFixture(l);
        const cases: [Parameters<Ledger['queryVotes']>[0], (v: VoteRecord) => boolean][] = [
          [{ engine: 'priceAction' }, (v) => v.engine === 'priceAction'],
          [{ asset: 'GBPUSD' }, (v) => v.asset === 'GBPUSD'],
          [{ isOTC: true }, (v) => v.isOTC],
          [{ isOTC: false }, (v) => !v.isOTC],
          [{ tf: '5m' }, (v) => v.tf === '5m'],
          [{ bucket: 11 }, (v) => v.bucket === 11],
          [{ bucket: 3 }, () => false],
          [{ engine: 'null', asset: 'EURUSD_otc', tf: '1m', bucket: 10 }, (v) => v.engine === 'null' && v.asset === 'EURUSD_otc' && v.tf === '1m' && v.bucket === 10],
        ];
        for (const [q, pred] of cases) expect(ids(await l.queryVotes(q)), JSON.stringify(q)).toEqual(expectedOrder(votes.filter(pred)));
      });

      it('fromTs is inclusive and toTs exclusive, both on candleOpenTs', async () => {
        const l = await make();
        const { votes } = await loadFixture(l);
        const from = T0 + 30 * MIN, to = T0 + 90 * MIN;
        expect(ids(await l.queryVotes({ fromTs: from, toTs: to }))).toEqual(
          expectedOrder(votes.filter((v) => v.candleOpenTs >= from && v.candleOpenTs < to)),
        );
        expect(ids(await l.queryVotes({ fromTs: from }))).toEqual(expectedOrder(votes.filter((v) => v.candleOpenTs >= from)));
        expect(ids(await l.queryVotes({ toTs: to }))).toEqual(expectedOrder(votes.filter((v) => v.candleOpenTs < to)));
      });

      it('scoredOnly keeps only votes that have an outcome', async () => {
        const l = await make();
        const { votes, scored } = await loadFixture(l);
        const rows = await l.queryVotes({ scoredOnly: true });
        expect(ids(rows)).toEqual(expectedOrder(votes.filter((v) => scored.has(v.voteId))));
        expect(rows.every((r) => r.outcome !== null)).toBe(true);
      });

      it('lastN keeps the most recent N after the other filters, still oldest first', async () => {
        const l = await make();
        const { votes, scored } = await loadFixture(l);
        const mine = votes.filter((v) => v.engine === 'null' && v.asset === 'GBPUSD' && v.tf === '1m');
        expect(ids(await l.queryVotes({ engine: 'null', asset: 'GBPUSD', tf: '1m', lastN: 3 }))).toEqual(expectedOrder(mine).slice(-3));
        const mineScored = mine.filter((v) => scored.has(v.voteId));
        expect(ids(await l.queryVotes({ engine: 'null', asset: 'GBPUSD', tf: '1m', scoredOnly: true, lastN: 2 }))).toEqual(
          expectedOrder(mineScored).slice(-2),
        );
        expect(ids(await l.queryVotes({ engine: 'null', asset: 'GBPUSD', tf: '1m', lastN: 100 }))).toEqual(expectedOrder(mine));
        // Across assets and timeframes, ties on candleOpenTs are cut by voteId order.
        expect(ids(await l.queryVotes({ isOTC: false, lastN: 5 }))).toEqual(expectedOrder(votes.filter((v) => !v.isOTC)).slice(-5));
        const ranged = votes.filter((v) => v.candleOpenTs < T0 + 60 * MIN && v.engine === 'priceAction');
        expect(ids(await l.queryVotes({ engine: 'priceAction', toTs: T0 + 60 * MIN, lastN: 4 }))).toEqual(expectedOrder(ranged).slice(-4));
      });
    });

    // -------------------------------------------------------------------------
    describe('signals', () => {
      it('appendSignal stores signals; listSignals filters by asset and time, oldest first', async () => {
        const l = await make();
        const all = [0, 1, 2, 3].flatMap((i) => [
          signal({ asset: 'EURUSD_otc', candleOpenTs: T0 + i * 10 * MIN }),
          signal({ asset: 'GBPUSD', candleOpenTs: T0 + i * 10 * MIN, direction: 'NO_TRADE', stakeShadow: null }),
        ]);
        for (const s of shuffled(all)) await l.appendSignal(s);
        const listed = await l.listSignals({});
        expect(listed).toHaveLength(8);
        expect(isSortedBy(listed, (a, b) => a.ts - b.ts)).toBe(true);
        expect(listed.find((s) => s.asset === 'GBPUSD')).toEqual(all[1]);
        const eur = await l.listSignals({ asset: 'EURUSD_otc' });
        expect(eur.map((s) => s.candleOpenTs)).toEqual([0, 1, 2, 3].map((i) => T0 + i * 10 * MIN));
        // Boundaries sit between signals, so it does not matter whether the range applies to ts or candleOpenTs.
        const ranged = await l.listSignals({ asset: 'EURUSD_otc', fromTs: T0 + 8 * MIN, toTs: T0 + 28 * MIN });
        expect(ranged.map((s) => s.candleOpenTs)).toEqual([T0 + 10 * MIN, T0 + 20 * MIN]);
      });

      it('appendSignal rejects an existing signalId with LedgerConflictError', async () => {
        const l = await make();
        await l.appendSignal(signal());
        await expect(l.appendSignal(signal({ p: 0.4, direction: 'DOWN' }))).rejects.toBeInstanceOf(LedgerConflictError);
        expect((await l.listSignals({}))[0]!.p).toBe(0.6);
      });
    });

    // -------------------------------------------------------------------------
    describe('events', () => {
      it('appendEvent assigns strictly increasing seq numbers and returns them', async () => {
        const l = await make();
        const seqs: number[] = [];
        for (let i = 0; i < 5; i++) seqs.push(await l.appendEvent({ ts: T0 + i * MIN, kind: 'info', payload: { i } }));
        for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
        expect((await l.listEvents({})).map((e) => e.seq)).toEqual(seqs);
      });

      it('listEvents filters by kind, asset and time range, oldest first, and keeps the payload', async () => {
        const l = await make();
        const input: Omit<EventRecord, 'seq'>[] = [
          { ts: T0, kind: 'feed_gap', asset: 'EURUSD', payload: { fromOpenTs: T0 - 3 * MIN, missing: 2 } },
          { ts: T0 + MIN, kind: 'info', engine: 'priceAction', payload: { error: 'boom' } },
          { ts: T0 + 2 * MIN, kind: 'candle_mismatch', asset: 'EURUSD_otc', payload: { nested: { a: [1, 2] } } },
          { ts: T0 + 3 * MIN, kind: 'feed_gap', asset: 'EURUSD_otc', payload: {} },
          { ts: T0 + 4 * MIN, kind: 'kill', asset: 'EURUSD', engine: 'priceAction', payload: { acc: 0.48 } },
        ];
        for (const e of input) await l.appendEvent(e);
        const all = await l.listEvents({});
        expect(all.map(({ seq: _seq, ...rest }) => rest)).toEqual(input);
        expect((await l.listEvents({ kind: 'feed_gap' })).map((e) => e.ts)).toEqual([T0, T0 + 3 * MIN]);
        expect((await l.listEvents({ asset: 'EURUSD' })).map((e) => e.kind)).toEqual(['feed_gap', 'kill']);
        expect((await l.listEvents({ fromTs: T0 + MIN, toTs: T0 + 3 * MIN })).map((e) => e.ts)).toEqual([T0 + MIN, T0 + 2 * MIN]);
        expect((await l.listEvents({ kind: 'feed_gap', asset: 'EURUSD_otc' })).map((e) => e.ts)).toEqual([T0 + 3 * MIN]);
      });
    });

    // -------------------------------------------------------------------------
    describe('raw frames', () => {
      it('assigns increasing seq; listRawFrames filters by tabId, fromSeq (inclusive) and limit', async () => {
        const l = await make();
        const frame = (tabId: number, i: number) => ({ receivedAt: 1000 + i, tabId, socketUrl: 'wss://x/socket.io', dir: 'in' as const, encoding: 'text' as const, data: `42["tick",${i}]` });
        await l.appendRawFrames([frame(1, 0), frame(2, 1), frame(1, 2)]);
        await l.appendRawFrames([frame(1, 3)]);
        const all = await l.listRawFrames({});
        expect(all.map((f) => f.data)).toEqual([0, 1, 2, 3].map((i) => `42["tick",${i}]`));
        expect(isSortedBy(all, (a, b) => a.seq - b.seq) && new Set(all.map((f) => f.seq)).size === 4).toBe(true);
        expect((await l.listRawFrames({ tabId: 1 })).map((f) => f.receivedAt)).toEqual([1000, 1002, 1003]);
        expect((await l.listRawFrames({ fromSeq: all[2]!.seq })).map((f) => f.receivedAt)).toEqual([1002, 1003]);
        expect((await l.listRawFrames({ tabId: 1, limit: 2 })).map((f) => f.receivedAt)).toEqual([1000, 1002]);
        expect(all[0]).toMatchObject({ tabId: 1, socketUrl: 'wss://x/socket.io', dir: 'in', encoding: 'text' });
      });
    });

    // -------------------------------------------------------------------------
    describe('ticks', () => {
      it('ignores ticks with an existing asset+ts, across calls and within one batch (first write wins)', async () => {
        const l = await make();
        await l.appendTicks([{ asset: 'A', ts: T0, price: 1.1 }, { asset: 'A', ts: T0 + 1000, price: 1.2 }]);
        await l.appendTicks([{ asset: 'A', ts: T0, price: 9.9 }, { asset: 'A', ts: T0 + 2000, price: 1.3 }, { asset: 'A', ts: T0 + 2000, price: 9.9 }]);
        expect(await l.getTicks('A')).toEqual([
          { asset: 'A', ts: T0, price: 1.1 }, { asset: 'A', ts: T0 + 1000, price: 1.2 }, { asset: 'A', ts: T0 + 2000, price: 1.3 },
        ]);
      });

      it('returns ticks oldest first per asset, with a fromTs-inclusive, toTs-exclusive range', async () => {
        const l = await make();
        await l.appendTicks([3, 1, 4, 0, 2].map((i) => ({ asset: 'A', ts: T0 + i * 1000, price: 1 + i })));
        await l.appendTicks([{ asset: 'B', ts: T0 + 500, price: 7 }]);
        expect((await l.getTicks('A')).map((t) => t.ts)).toEqual([0, 1, 2, 3, 4].map((i) => T0 + i * 1000));
        expect((await l.getTicks('A', { fromTs: T0 + 1000, toTs: T0 + 3000 })).map((t) => t.price)).toEqual([2, 3]);
        expect(await l.getTicks('B')).toEqual([{ asset: 'B', ts: T0 + 500, price: 7 }]);
        expect(await l.getTicks('C')).toEqual([]);
      });
    });

    // -------------------------------------------------------------------------
    describe('candles', () => {
      it('getCandles returns one series oldest first, with a range on openTs', async () => {
        const l = await make();
        for (const i of [2, 0, 3, 1]) await l.putCandle(candle({ openTs: T0 + i * MIN, close: 1 + i }));
        await l.putCandle(candle({ tf: '5m', openTs: T0 }));
        await l.putCandle(candle({ asset: 'GBPUSD', openTs: T0 }));
        const series = await l.getCandles('EURUSD_otc', '1m');
        expect(series.map((c) => c.openTs)).toEqual([0, 1, 2, 3].map((i) => T0 + i * MIN));
        expect(series[1]).toEqual(candle({ openTs: T0 + MIN, close: 2 }));
        expect((await l.getCandles('EURUSD_otc', '1m', { fromTs: T0 + MIN, toTs: T0 + 3 * MIN })).map((c) => c.close)).toEqual([2, 3]);
        expect(await l.getCandles('EURUSD_otc', '5m')).toHaveLength(1);
        expect(await l.getCandles('EURUSD_otc', '2m')).toEqual([]);
      });

      it("a 'feed' candle replaces a 'rebuilt' one; a 'rebuilt' candle never replaces a 'feed' one", async () => {
        const l = await make();
        await l.putCandle(candle({ openTs: T0, close: 1.2, source: 'rebuilt' }));
        await l.putCandle(candle({ openTs: T0, close: 1.3, source: 'feed' }));
        await l.putCandle(candle({ openTs: T0, close: 1.4, source: 'rebuilt' }));
        expect(await l.getCandles('EURUSD_otc', '1m')).toEqual([candle({ openTs: T0, close: 1.3, source: 'feed' })]);
      });

      it('a later candle of the same source replaces the earlier one', async () => {
        const l = await make();
        await l.putCandle(candle({ openTs: T0, close: 1.2, source: 'rebuilt' }));
        await l.putCandle(candle({ openTs: T0, close: 1.25, source: 'rebuilt' }));
        await l.putCandle(candle({ openTs: T0 + MIN, close: 1.3, source: 'feed' }));
        await l.putCandle(candle({ openTs: T0 + MIN, close: 1.35, source: 'feed' }));
        expect((await l.getCandles('EURUSD_otc', '1m')).map((c) => [c.close, c.source])).toEqual([[1.25, 'rebuilt'], [1.35, 'feed']]);
      });

      it('countCandles counts per asset|tf and listAssets lists assets with their class', async () => {
        const l = await make();
        for (let i = 0; i < 3; i++) await l.putCandle(candle({ openTs: T0 + i * MIN }));
        await l.putCandle(candle({ openTs: T0, source: 'feed' })); // same key, not a new candle
        await l.putCandle(candle({ tf: '5m', openTs: T0 }));
        await l.putCandle(candle({ asset: 'GBPUSD', openTs: T0 }));
        expect(await l.countCandles()).toEqual({ 'EURUSD_otc|1m': 3, 'EURUSD_otc|5m': 1, 'GBPUSD|1m': 1 });
        const assets = (await l.listAssets()).slice().sort((a, b) => cmpS(a.asset, b.asset));
        expect(assets).toEqual([{ asset: 'EURUSD_otc', isOTC: true }, { asset: 'GBPUSD', isOTC: false }]);
      });
    });

    // -------------------------------------------------------------------------
    describe('payouts', () => {
      it('latestPayout returns the newest payout at or before a time, per asset', async () => {
        const l = await make();
        await l.appendPayout({ asset: 'A', ts: T0, percent: 85 });
        await l.appendPayout({ asset: 'A', ts: T0 + 10 * MIN, percent: 90 });
        await l.appendPayout({ asset: 'B', ts: T0 + 5 * MIN, percent: 70 });
        expect(await l.latestPayout('A', T0 - 1)).toBeNull();
        expect(await l.latestPayout('A', T0)).toEqual({ asset: 'A', ts: T0, percent: 85 });
        expect(await l.latestPayout('A', T0 + 10 * MIN - 1)).toEqual({ asset: 'A', ts: T0, percent: 85 });
        expect(await l.latestPayout('A', T0 + 10 * MIN)).toEqual({ asset: 'A', ts: T0 + 10 * MIN, percent: 90 });
        expect(await l.latestPayout('B', T0 + DAY)).toEqual({ asset: 'B', ts: T0 + 5 * MIN, percent: 70 });
        expect(await l.latestPayout('C', T0 + DAY)).toBeNull();
      });

      it('appending the same payout twice keeps one record', async () => {
        const l = await make();
        await l.appendPayout({ asset: 'A', ts: T0, percent: 85 });
        await l.appendPayout({ asset: 'A', ts: T0, percent: 85 });
        expect((await l.export()).payouts).toEqual([{ asset: 'A', ts: T0, percent: 85 }]);
      });
    });

    // -------------------------------------------------------------------------
    describe('feed structure, patterns, engine stats and engine state', () => {
      it('putFeedStructure stores by asset+ts and replaces the same key', async () => {
        const l = await make();
        await l.putFeedStructure(feedStructure('A', T0));
        await l.putFeedStructure({ ...feedStructure('A', T0), label: 'trending', strength: 0.7 });
        await l.putFeedStructure(feedStructure('A', T0 + MIN));
        const fs = (await l.export()).feedStructure;
        expect(fs).toHaveLength(2);
        expect(fs[0]).toEqual({ ...feedStructure('A', T0), label: 'trending', strength: 0.7 });
      });

      it('putPattern stores by asset+key and replaces; listPatterns lists one asset sorted by key', async () => {
        const l = await make();
        await l.putPattern(pattern('A', 'RRG'));
        await l.putPattern(pattern('A', 'GG'));
        await l.putPattern(pattern('B', 'GR'));
        await l.putPattern(pattern('A', 'RRG', { status: 'validated', validatedAt: T0 + DAY, winsB: 70 }));
        const a = await l.listPatterns('A');
        expect(a.map((p) => p.key)).toEqual(['GG', 'RRG']);
        expect(a[1]).toEqual(pattern('A', 'RRG', { status: 'validated', validatedAt: T0 + DAY, winsB: 70 }));
        expect(await l.listPatterns('B')).toEqual([pattern('B', 'GR')]);
        expect(await l.listPatterns('Z')).toEqual([]);
      });

      it("engine stats are keyed by engine+asset+bucket, with numeric buckets and 'all' kept apart", async () => {
        const l = await make();
        await l.putEngineStats(stats('null', 'A', 'all', 10));
        await l.putEngineStats(stats('null', 'A', 7, 3));
        await l.putEngineStats(stats('null', 'A', 7, 4));
        expect(await l.getEngineStats('null', 'A', 'all')).toEqual(stats('null', 'A', 'all', 10));
        expect(await l.getEngineStats('null', 'A', 7)).toEqual(stats('null', 'A', 7, 4));
        expect(await l.getEngineStats('null', 'A', 8)).toBeNull();
        expect(await l.getEngineStats('null', 'B', 'all')).toBeNull();
      });

      it('engine state keeps the latest write per engine, as a deep copy', async () => {
        const l = await make();
        expect(await l.getEngineState('null')).toBeNull();
        const state = { assets: { A: { votes: 1, recent: [1, 0] } } };
        await l.putEngineState({ engine: 'null', ts: T0, state });
        state.assets.A.votes = 99;
        expect(await l.getEngineState('null')).toEqual({ engine: 'null', ts: T0, state: { assets: { A: { votes: 1, recent: [1, 0] } } } });
        await l.putEngineState({ engine: 'null', ts: T0 + MIN, state: { assets: {} } });
        expect(await l.getEngineState('null')).toEqual({ engine: 'null', ts: T0 + MIN, state: { assets: {} } });
      });
    });

    // -------------------------------------------------------------------------
    describe('export', () => {
      async function fill(l: Ledger, salt: number): Promise<void> {
        const votes = voteFixture();
        for (const v of shuffled(votes, salt)) await l.appendVote(v);
        for (const v of shuffled(votes.filter((x) => x.direction !== 'ABSTAIN'), salt + 1)) await l.appendOutcome(outcome(v));
        for (const s of shuffled([0, 1, 2].map((i) => signal({ candleOpenTs: T0 + i * MIN })), salt)) await l.appendSignal(s);
        // Events are ordered by seq, which is write order, so they are written in the same order.
        await l.appendEvent({ ts: T0, kind: 'reload', payload: { why: 'test' } });
        await l.appendEvent({ ts: T0 + MIN, kind: 'info', asset: 'GBPUSD', payload: {} });
        const cs = ['EURUSD_otc', 'GBPUSD', 'AUDCAD_otc'].flatMap((asset) =>
          (['1m', '5m'] as const).flatMap((tf) => [0, 1, 2].map((i) => candle({ asset, tf, openTs: T0 + i * 5 * MIN }))));
        for (const c of shuffled(cs, salt)) await l.putCandle(c);
        for (const p of shuffled([0, 1, 2].flatMap((i) => [{ asset: 'GBPUSD', ts: T0 + i, percent: 80 + i }, { asset: 'AUDCAD_otc', ts: T0 + i, percent: 90 }]), salt))
          await l.appendPayout(p);
        for (const r of shuffled([feedStructure('GBPUSD', T0 + 1), feedStructure('AUDCAD_otc', T0), feedStructure('GBPUSD', T0)], salt)) await l.putFeedStructure(r);
        for (const p of shuffled([pattern('B', 'GR'), pattern('A', 'RRG'), pattern('A', 'GG')], salt)) await l.putPattern(p);
        for (const s of shuffled([stats('null', 'A', 'all'), stats('null', 'A', 10), stats('null', 'A', 9), stats('alpha', 'B', 'all'), stats('null', 'AA', 0)], salt)) await l.putEngineStats(s);
        for (const t of shuffled([3, 1, 2, 0].flatMap((i) => [{ asset: 'GBPUSD', ts: T0 + i * 1000, price: 1 + i }, { asset: 'AUDCAD_otc', ts: T0 + i * 1000, price: 2 }]), salt))
          await l.appendTicks([t]);
      }

      it('has format bbqx-ledger version 1 and omits ticks unless includeTicks is set', async () => {
        const l = await make();
        await fill(l, 1);
        const plain = await l.export();
        expect(plain.format).toBe('bbqx-ledger');
        expect(plain.version).toBe(1);
        expect(plain.ticks).toBeUndefined();
        const withTicks = await l.export({ includeTicks: true });
        expect(withTicks.ticks).toHaveLength(8);
      });

      it('sorts every array by its store key', async () => {
        const l = await make();
        await fill(l, 3);
        const e: LedgerExport = await l.export({ includeTicks: true });
        expect(e.votes.length).toBeGreaterThan(0);
        expect(isSortedBy(e.votes, (a, b) => cmpS(a.voteId, b.voteId))).toBe(true);
        expect(isSortedBy(e.outcomes, (a, b) => cmpS(a.voteId, b.voteId))).toBe(true);
        expect(isSortedBy(e.signals, (a, b) => cmpS(a.signalId, b.signalId))).toBe(true);
        expect(isSortedBy(e.events, (a, b) => a.seq - b.seq)).toBe(true);
        expect(isSortedBy(e.candles, (a, b) => cmpS(a.asset, b.asset) || cmpS(a.tf, b.tf) || cmpN(a.openTs, b.openTs))).toBe(true);
        expect(isSortedBy(e.payouts, (a, b) => cmpS(a.asset, b.asset) || cmpN(a.ts, b.ts))).toBe(true);
        expect(isSortedBy(e.feedStructure, (a, b) => cmpS(a.asset, b.asset) || cmpN(a.ts, b.ts))).toBe(true);
        expect(isSortedBy(e.patterns, (a, b) => cmpS(a.asset, b.asset) || cmpS(a.key, b.key))).toBe(true);
        expect(e.engineStats.map((s) => `${s.engine}|${s.asset}|${s.bucket}`)).toEqual(['alpha|B|all', 'null|A|9', 'null|A|10', 'null|A|all', 'null|AA|0']);
        expect(isSortedBy(e.engineStats, (a, b) => cmpS(a.engine, b.engine) || cmpS(a.asset, b.asset) || cmpBucket(a.bucket, b.bucket))).toBe(true);
        expect(isSortedBy(e.ticks!, (a, b) => cmpS(a.asset, b.asset) || cmpN(a.ts, b.ts))).toBe(true);
        expect(e.candles).toHaveLength(18);
      });

      it('is byte-stable: the same records written in a different order export identically', async () => {
        const a = await make(), b = await make();
        await fill(a, 5);
        await fill(b, 11);
        expect(JSON.stringify(await a.export({ includeTicks: true }))).toBe(JSON.stringify(await b.export({ includeTicks: true })));
      });

      it('exporting twice gives the same bytes and changes nothing', async () => {
        const l = await make();
        await fill(l, 7);
        const first = JSON.stringify(await l.export({ includeTicks: true }));
        const e = await l.export();
        e.votes.length = 0;
        expect(JSON.stringify(await l.export({ includeTicks: true }))).toBe(first);
      });
    });

    // -------------------------------------------------------------------------
    describe('prune', () => {
      const NOW = T0 + 40 * DAY;

      it('drops ticks older than the tick retention per asset and keeps the rest', async () => {
        const R = TUNABLES.retentionTicksMs.value;
        const l = await make();
        const at = (asset: string, ts: number) => ({ asset, ts, price: 1 });
        await l.appendTicks([at('A', NOW - R - HOUR), at('A', NOW - R - 1), at('A', NOW - R), at('A', NOW - HOUR), at('A', NOW)]);
        await l.appendTicks([at('B', NOW - R - 3 * HOUR), at('B', NOW - R - 1), at('B', NOW)]);
        await l.prune(NOW);
        expect((await l.getTicks('A')).map((t) => t.ts)).toEqual([NOW - R, NOW - HOUR, NOW]);
        expect((await l.getTicks('B')).map((t) => t.ts)).toEqual([NOW]);
      });

      it('replaces 1m candles older than 30 days with 5m aggregates and keeps newer ones', async () => {
        const l = await make();
        const old = NOW - 31 * DAY; // 5m-aligned
        const prices = [[1.10, 1.12, 1.09, 1.11], [1.11, 1.13, 1.10, 1.12], [1.12, 1.15, 1.12, 1.14], [1.14, 1.14, 1.08, 1.09], [1.09, 1.10, 1.07, 1.08]];
        for (const [i, [open, high, low, close]] of prices.entries())
          await l.putCandle(candle({ asset: 'GBPUSD', openTs: old + i * MIN, open: open!, high: high!, low: low!, close: close!, tickCount: 10 + i }));
        const recent = candle({ asset: 'GBPUSD', openTs: NOW - 29 * DAY });
        await l.putCandle(recent);
        const old2m = candle({ asset: 'GBPUSD', tf: '2m', openTs: NOW - 40 * DAY });
        await l.putCandle(old2m);
        const old5m = candle({ asset: 'GBPUSD', tf: '5m', openTs: NOW - 39 * DAY });
        await l.putCandle(old5m);
        await l.prune(NOW);
        expect(await l.getCandles('GBPUSD', '1m')).toEqual([recent]);
        expect(await l.getCandles('GBPUSD', '2m')).toEqual([old2m]);
        const five = await l.getCandles('GBPUSD', '5m');
        expect(five).toHaveLength(2);
        expect(five[0]).toEqual(old5m);
        expect(five[1]).toMatchObject({ asset: 'GBPUSD', isOTC: false, tf: '5m', openTs: old, open: 1.10, high: 1.15, low: 1.07, close: 1.08, tickCount: 60 });
      });

      it('drops payouts and feed_structure older than 30 days', async () => {
        const l = await make();
        await l.appendPayout({ asset: 'A', ts: NOW - 31 * DAY, percent: 80 });
        await l.appendPayout({ asset: 'A', ts: NOW - 29 * DAY, percent: 85 });
        await l.putFeedStructure(feedStructure('A', NOW - 31 * DAY));
        await l.putFeedStructure(feedStructure('A', NOW - 29 * DAY));
        await l.prune(NOW);
        const e = await l.export();
        expect(e.payouts.map((p) => p.ts)).toEqual([NOW - 29 * DAY]);
        expect(e.feedStructure.map((r) => r.ts)).toEqual([NOW - 29 * DAY]);
        expect(await l.latestPayout('A', NOW - 30 * DAY)).toBeNull();
      });

      it('never deletes votes, outcomes, signals, events, patterns, engine stats or engine state', async () => {
        const l = await make();
        const ancient = NOW - 400 * DAY;
        const v = vote({ candleOpenTs: ancient });
        await l.appendVote(v);
        await l.appendOutcome(outcome(v));
        await l.appendSignal(signal({ candleOpenTs: ancient }));
        await l.appendEvent({ ts: ancient, kind: 'drift_alarm', asset: 'A', payload: {} });
        await l.putPattern(pattern('A', 'GRG', { firstSeen: ancient, lastSeen: ancient }));
        await l.putEngineStats(stats('null', 'A', 'all'));
        await l.putEngineState({ engine: 'null', ts: ancient, state: { x: 1 } });
        const before = await l.export();
        await l.prune(NOW);
        await l.prune(NOW + 365 * DAY);
        const after = await l.export();
        expect(after.votes).toEqual(before.votes);
        expect(after.outcomes).toEqual(before.outcomes);
        expect(after.signals).toEqual(before.signals);
        expect(after.events).toEqual(before.events);
        expect(after.patterns).toEqual(before.patterns);
        expect(after.engineStats).toEqual(before.engineStats);
        expect(await l.getEngineState('null')).toEqual({ engine: 'null', ts: ancient, state: { x: 1 } });
      });

      it('is idempotent', async () => {
        const l = await make();
        for (let i = 0; i < 10; i++) await l.putCandle(candle({ openTs: NOW - 31 * DAY + i * MIN }));
        await l.appendTicks([{ asset: 'A', ts: NOW - TUNABLES.retentionTicksMs.value - HOUR, price: 1 }, { asset: 'A', ts: NOW, price: 1 }]);
        await l.prune(NOW);
        const once = JSON.stringify(await l.export({ includeTicks: true }));
        await l.prune(NOW);
        expect(JSON.stringify(await l.export({ includeTicks: true }))).toBe(once);
      });
    });
  });
}
