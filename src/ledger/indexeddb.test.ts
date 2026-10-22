import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  LedgerConflictError,
  voteIdOf,
  signalIdOf,
  type CandleRecord,
  type EngineStatsRecord,
  type OutcomeRecord,
  type PatternRecord,
  type SignalRecord,
  type VoteRecord,
} from '../core/contracts';
import { TUNABLES } from '../core/tunables';
import { aggregateCandles, openIndexedDbLedger, type IndexedDbLedger } from './indexeddb';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);

let dbCounter = 0;
let ledger: IndexedDbLedger;

beforeEach(async () => {
  ledger = await openIndexedDbLedger(`bbqx-test-${++dbCounter}`);
});

function vote(over: Partial<VoteRecord> & { engine: string; asset: string; candleOpenTs: number }): VoteRecord {
  const tf = over.tf ?? '1m';
  return {
    voteId: voteIdOf(over.asset, tf, over.candleOpenTs, over.engine),
    ts: over.candleOpenTs - 5000,
    isOTC: over.asset.endsWith('_otc'),
    tf,
    bucket: new Date(over.candleOpenTs).getUTCHours(),
    direction: 'UP',
    confidence: 0.6,
    reasons: ['test'],
    payoutAtVote: 0.85,
    frozenAt: over.candleOpenTs - 5000,
    ...over,
  };
}

function outcome(voteId: string, result: OutcomeRecord['result'] = 'WIN'): OutcomeRecord {
  return { voteId, result, openPrice: 1, closePrice: 1.1, scoredAt: T0 };
}

function candle(asset: string, openTs: number, source: CandleRecord['source'], over: Partial<CandleRecord> = {}): CandleRecord {
  return { asset, isOTC: asset.endsWith('_otc'), tf: '1m', openTs, open: 1, high: 2, low: 0.5, close: 1.5, tickCount: 10, source, ...over };
}

function signal(asset: string, candleOpenTs: number, ts: number): SignalRecord {
  return {
    signalId: signalIdOf(asset, '1m', candleOpenTs),
    ts,
    asset,
    isOTC: false,
    tf: '1m',
    candleOpenTs,
    bucket: 12,
    p: 0.5,
    threshold: 0.56,
    direction: 'NO_TRADE',
    stakeShadow: null,
    gateFlags: {},
    engineWeights: {},
  };
}

function pattern(asset: string, key: string, firstSeen: number): PatternRecord {
  return { asset, key, status: 'candidate', occurrences: 1, winsA: 0, winsB: 0, days: 1, firstSeen, lastSeen: firstSeen, validatedAt: null, expiredAt: null };
}

function stats(engine: string, asset: string, bucket: number | 'all', votes = 1): EngineStatsRecord {
  return { engine, asset, bucket, votes, abstains: 0, hits: 0, ties: 0, last100: null, last200: null, brier: null, killed: false };
}

describe('append-only stores', () => {
  it('appends votes and rejects a duplicate voteId with LedgerConflictError', async () => {
    const v = vote({ engine: 'null', asset: 'EURUSD', candleOpenTs: T0 });
    await ledger.appendVote(v);
    await expect(ledger.appendVote({ ...v, confidence: 0.9 })).rejects.toBeInstanceOf(LedgerConflictError);
    const all = await ledger.queryVotes({});
    expect(all).toHaveLength(1);
    expect(all[0]!.vote.confidence).toBe(0.6);
  });

  it('appends outcomes, rejects duplicates, and getOutcome returns null when missing', async () => {
    const o = outcome('a|1m|1|null');
    await ledger.appendOutcome(o);
    await expect(ledger.appendOutcome({ ...o, result: 'LOSS' })).rejects.toBeInstanceOf(LedgerConflictError);
    expect(await ledger.getOutcome(o.voteId)).toEqual(o);
    expect(await ledger.getOutcome('missing')).toBeNull();
  });

  it('appends signals, rejects duplicates, lists by ts range and asset, oldest first', async () => {
    await ledger.appendSignal(signal('B', T0 + MIN, T0 + MIN - 5000));
    await ledger.appendSignal(signal('A', T0, T0 - 5000));
    await ledger.appendSignal(signal('A', T0 + 2 * MIN, T0 + 2 * MIN - 5000));
    await expect(ledger.appendSignal(signal('A', T0, T0))).rejects.toBeInstanceOf(LedgerConflictError);
    expect((await ledger.listSignals({})).map((s) => s.signalId)).toEqual([
      signalIdOf('A', '1m', T0),
      signalIdOf('B', '1m', T0 + MIN),
      signalIdOf('A', '1m', T0 + 2 * MIN),
    ]);
    expect((await ledger.listSignals({ asset: 'A' })).map((s) => s.candleOpenTs)).toEqual([T0, T0 + 2 * MIN]);
    expect((await ledger.listSignals({ fromTs: T0, toTs: T0 + 2 * MIN - 5000 })).map((s) => s.asset)).toEqual(['B']);
    expect(await ledger.listSignals({ fromTs: T0, toTs: T0 })).toEqual([]);
  });

  it('assigns strictly increasing event seqs and filters events by kind, asset and range', async () => {
    const s1 = await ledger.appendEvent({ ts: T0 + 10, kind: 'info', payload: { a: 1 } });
    const s2 = await ledger.appendEvent({ ts: T0, kind: 'kill', asset: 'X', engine: 'e', payload: {} });
    const s3 = await ledger.appendEvent({ ts: T0 + 20, kind: 'kill', asset: 'Y', payload: {} });
    expect(s2).toBeGreaterThan(s1);
    expect(s3).toBeGreaterThan(s2);
    const all = await ledger.listEvents({});
    expect(all.map((e) => e.seq)).toEqual([s2, s1, s3]);
    expect(JSON.stringify(all[1])).toBe(JSON.stringify({ seq: s1, ts: T0 + 10, kind: 'info', payload: { a: 1 } }));
    expect(JSON.stringify(all[0])).toBe(JSON.stringify({ seq: s2, ts: T0, kind: 'kill', asset: 'X', engine: 'e', payload: {} }));
    expect((await ledger.listEvents({ kind: 'kill' })).map((e) => e.asset)).toEqual(['X', 'Y']);
    expect((await ledger.listEvents({ asset: 'Y' })).map((e) => e.seq)).toEqual([s3]);
    expect((await ledger.listEvents({ fromTs: T0 + 10, toTs: T0 + 20 })).map((e) => e.seq)).toEqual([s1]);
  });

  it('appends raw frames with ledger-assigned seq and lists them by tab, fromSeq and limit', async () => {
    const base = { receivedAt: T0, socketUrl: 'wss://x', dir: 'in' as const, encoding: 'text' as const };
    await ledger.appendRawFrames([
      { ...base, tabId: 1, data: 'a' },
      { ...base, tabId: 2, data: 'b' },
      { ...base, tabId: 1, data: 'c' },
    ]);
    await ledger.appendRawFrames([]);
    await ledger.appendRawFrames([{ ...base, tabId: 1, data: 'd' }]);
    const all = await ledger.listRawFrames({});
    expect(all.map((f) => f.data)).toEqual(['a', 'b', 'c', 'd']);
    const seqs = all.map((f) => f.seq);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(4);
    expect((await ledger.listRawFrames({ tabId: 1 })).map((f) => f.data)).toEqual(['a', 'c', 'd']);
    expect((await ledger.listRawFrames({ tabId: 1, fromSeq: seqs[2]! })).map((f) => f.data)).toEqual(['c', 'd']);
    expect((await ledger.listRawFrames({ fromSeq: seqs[1]!, limit: 2 })).map((f) => f.data)).toEqual(['b', 'c']);
    expect(await ledger.listRawFrames({ limit: 0 })).toEqual([]);
    expect(await ledger.countRawFrames()).toBe(4);
  });
});

describe('queryVotes', () => {
  beforeEach(async () => {
    // Two engines, two assets (one OTC), two timeframes, a few candles across two hours.
    const opens = [T0, T0 + MIN, T0 + 2 * MIN, T0 + HOUR];
    for (const candleOpenTs of opens) {
      for (const engine of ['null', 'pa']) {
        await ledger.appendVote(vote({ engine, asset: 'EURUSD', candleOpenTs }));
        await ledger.appendVote(vote({ engine, asset: 'GBPUSD_otc', candleOpenTs }));
      }
    }
    await ledger.appendVote(vote({ engine: 'pa', asset: 'EURUSD', candleOpenTs: T0, tf: '5m' }));
    // Score the null engine's EURUSD votes except the last one.
    for (const candleOpenTs of opens.slice(0, 3)) await ledger.appendOutcome(outcome(voteIdOf('EURUSD', '1m', candleOpenTs, 'null')));
  });

  it('returns everything oldest first by candleOpenTs, then voteId, with outcomes joined', async () => {
    const all = await ledger.queryVotes({});
    expect(all).toHaveLength(17);
    const keys = all.map((s) => [s.vote.candleOpenTs, s.vote.voteId] as const);
    const sorted = [...keys].sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
    expect(keys).toEqual(sorted);
    const scored = all.filter((s) => s.outcome !== null);
    expect(scored.map((s) => s.vote.voteId)).toEqual([T0, T0 + MIN, T0 + 2 * MIN].map((t) => voteIdOf('EURUSD', '1m', t, 'null')));
  });

  it('filters by engine, asset, isOTC, tf and bucket', async () => {
    expect(await ledger.queryVotes({ engine: 'null' })).toHaveLength(8);
    expect(await ledger.queryVotes({ asset: 'GBPUSD_otc' })).toHaveLength(8);
    expect(await ledger.queryVotes({ engine: 'pa', asset: 'EURUSD' })).toHaveLength(5);
    expect(await ledger.queryVotes({ engine: 'pa', asset: 'EURUSD', tf: '1m' })).toHaveLength(4);
    expect(await ledger.queryVotes({ tf: '5m' })).toHaveLength(1);
    expect((await ledger.queryVotes({ isOTC: true })).every((s) => s.vote.asset === 'GBPUSD_otc')).toBe(true);
    expect(await ledger.queryVotes({ isOTC: false })).toHaveLength(9);
    const b13 = await ledger.queryVotes({ bucket: 13 });
    expect(b13).toHaveLength(4);
    expect(b13.every((s) => s.vote.candleOpenTs === T0 + HOUR)).toBe(true);
  });

  it('applies fromTs inclusive and toTs exclusive on candleOpenTs', async () => {
    const r = await ledger.queryVotes({ engine: 'null', asset: 'EURUSD', fromTs: T0 + MIN, toTs: T0 + HOUR });
    expect(r.map((s) => s.vote.candleOpenTs)).toEqual([T0 + MIN, T0 + 2 * MIN]);
    expect(await ledger.queryVotes({ fromTs: T0 + MIN, toTs: T0 + MIN })).toEqual([]);
    expect(await ledger.queryVotes({ asset: 'EURUSD', toTs: T0 + 1 })).toHaveLength(3);
    expect(await ledger.queryVotes({ engine: 'pa', fromTs: T0 + HOUR })).toHaveLength(2);
  });

  it('supports scoredOnly and lastN, keeping the most recent N after the other filters', async () => {
    const scored = await ledger.queryVotes({ scoredOnly: true });
    expect(scored).toHaveLength(3);
    expect(scored.every((s) => s.outcome?.result === 'WIN')).toBe(true);
    const last2 = await ledger.queryVotes({ engine: 'null', asset: 'EURUSD', scoredOnly: true, lastN: 2 });
    expect(last2.map((s) => s.vote.candleOpenTs)).toEqual([T0 + MIN, T0 + 2 * MIN]);
    const lastAny = await ledger.queryVotes({ engine: 'null', asset: 'EURUSD', lastN: 2 });
    expect(lastAny.map((s) => s.vote.candleOpenTs)).toEqual([T0 + 2 * MIN, T0 + HOUR]);
    expect(lastAny[1]!.outcome).toBeNull();
    expect(await ledger.queryVotes({ lastN: 0 })).toEqual([]);
    expect(await ledger.queryVotes({ lastN: 100 })).toHaveLength(17);
  });

  it('finds scored votes beyond the first chunk when walking back for lastN', async () => {
    const asset = 'AUDCAD';
    for (let i = 0; i < 150; i++) await ledger.appendVote(vote({ engine: 'e', asset, candleOpenTs: T0 + i * MIN }));
    await ledger.appendOutcome(outcome(voteIdOf(asset, '1m', T0, 'e')));
    await ledger.appendOutcome(outcome(voteIdOf(asset, '1m', T0 + 149 * MIN, 'e')));
    const r = await ledger.queryVotes({ asset, scoredOnly: true, lastN: 2 });
    expect(r.map((s) => s.vote.candleOpenTs)).toEqual([T0, T0 + 149 * MIN]);
  });
});

describe('ticks', () => {
  it('ignores duplicate asset+ts, within a batch and across batches, keeping the first price', async () => {
    await ledger.appendTicks([
      { asset: 'A', ts: 2, price: 1.2 },
      { asset: 'A', ts: 1, price: 1.1 },
      { asset: 'A', ts: 1, price: 9.9 },
      { asset: 'B', ts: 1, price: 5 },
    ]);
    await ledger.appendTicks([{ asset: 'A', ts: 2, price: 7 }, { asset: 'A', ts: 3, price: 1.3 }]);
    await ledger.appendTicks([]);
    expect(await ledger.getTicks('A')).toEqual([
      { asset: 'A', ts: 1, price: 1.1 },
      { asset: 'A', ts: 2, price: 1.2 },
      { asset: 'A', ts: 3, price: 1.3 },
    ]);
    expect(await ledger.getTicks('A', { fromTs: 2, toTs: 3 })).toEqual([{ asset: 'A', ts: 2, price: 1.2 }]);
    expect(await ledger.getTicks('B')).toHaveLength(1);
    expect(await ledger.countTicks('A')).toBe(3);
    expect(await ledger.lastTick('A')).toEqual({ asset: 'A', ts: 3, price: 1.3 });
    expect(await ledger.lastTick('Z')).toBeNull();
    expect(await ledger.assetsIn('ticks')).toEqual(['A', 'B']);
  });

  it('pages ticks strictly after a timestamp', async () => {
    await ledger.appendTicks([1, 2, 3, 4, 5].map((ts) => ({ asset: 'A', ts, price: ts })));
    expect((await ledger.ticksPage('A', null, 2)).map((t) => t.ts)).toEqual([1, 2]);
    expect((await ledger.ticksPage('A', 2, 2)).map((t) => t.ts)).toEqual([3, 4]);
    expect((await ledger.ticksPage('A', 5, 2)).map((t) => t.ts)).toEqual([]);
  });

  it('accepts many ticks in one batch', async () => {
    const ticks = Array.from({ length: 2000 }, (_, i) => ({ asset: 'A', ts: T0 + i * 250, price: 1 + i / 1e5 }));
    await ledger.appendTicks(ticks);
    expect(await ledger.countTicks('A')).toBe(2000);
  });
});

describe('candles', () => {
  it('lets a feed candle replace a rebuilt one but never the reverse', async () => {
    await ledger.putCandle(candle('A', T0, 'rebuilt', { close: 1.1 }));
    await ledger.putCandle(candle('A', T0, 'rebuilt', { close: 1.2 }));
    expect((await ledger.getCandles('A', '1m'))[0]!.close).toBe(1.2);
    await ledger.putCandle(candle('A', T0, 'feed', { close: 1.3 }));
    expect((await ledger.getCandles('A', '1m'))[0]).toMatchObject({ source: 'feed', close: 1.3 });
    await ledger.putCandle(candle('A', T0, 'rebuilt', { close: 1.4 }));
    expect((await ledger.getCandles('A', '1m'))[0]).toMatchObject({ source: 'feed', close: 1.3 });
    await ledger.putCandle(candle('A', T0, 'feed', { close: 1.5 }));
    expect((await ledger.getCandles('A', '1m'))[0]).toMatchObject({ source: 'feed', close: 1.5 });
  });

  it('reads by asset, tf and openTs range, counts per series and lists assets', async () => {
    for (let i = 0; i < 5; i++) await ledger.putCandle(candle('EURUSD', T0 + i * MIN, 'rebuilt'));
    await ledger.putCandle(candle('EURUSD', T0, 'rebuilt', { tf: '5m' }));
    await ledger.putCandle(candle('GBPUSD_otc', T0, 'feed'));
    expect((await ledger.getCandles('EURUSD', '1m', { fromTs: T0 + MIN, toTs: T0 + 3 * MIN })).map((c) => c.openTs)).toEqual([T0 + MIN, T0 + 2 * MIN]);
    expect(await ledger.getCandles('EURUSD', '5m')).toHaveLength(1);
    expect(await ledger.getCandles('EURUSD', '2m')).toEqual([]);
    expect(await ledger.countCandles()).toEqual({ 'EURUSD|1m': 5, 'EURUSD|5m': 1, 'GBPUSD_otc|1m': 1 });
    expect((await ledger.lastCandles('EURUSD', '1m', 2)).map((c) => c.openTs)).toEqual([T0 + 3 * MIN, T0 + 4 * MIN]);
    expect((await ledger.candlesPage('EURUSD', '1m', T0 + 2 * MIN, 10)).map((c) => c.openTs)).toEqual([T0 + 3 * MIN, T0 + 4 * MIN]);
    await ledger.appendVote(vote({ engine: 'null', asset: 'AUDCAD_otc', candleOpenTs: T0 }));
    expect(await ledger.listAssets()).toEqual([
      { asset: 'AUDCAD_otc', isOTC: true },
      { asset: 'EURUSD', isOTC: false },
      { asset: 'GBPUSD_otc', isOTC: true },
    ]);
  });

  it('aggregates 1m candles into a 5m candle', () => {
    const parts = [
      candle('A', T0 + 2 * MIN, 'feed', { open: 3, high: 5, low: 2, close: 4, tickCount: 3 }),
      candle('A', T0, 'feed', { open: 1, high: 2, low: 0.5, close: 1.5, tickCount: 1 }),
      candle('A', T0 + MIN, 'rebuilt', { open: 1.5, high: 6, low: 1, close: 3, tickCount: 2 }),
    ];
    expect(aggregateCandles(T0, '5m', parts)).toEqual({
      asset: 'A', isOTC: false, tf: '5m', openTs: T0, open: 1, high: 6, low: 0.5, close: 4, tickCount: 6, source: 'rebuilt',
    });
    expect(aggregateCandles(T0, '5m', parts.slice(0, 2)).source).toBe('feed');
  });
});

describe('payouts, feed structure, patterns, engine stats and state', () => {
  it('returns the latest payout at or before a timestamp', async () => {
    await ledger.appendPayout({ asset: 'A', ts: T0, percent: 85 });
    await ledger.appendPayout({ asset: 'A', ts: T0 + MIN, percent: 90 });
    await ledger.appendPayout({ asset: 'B', ts: T0 - MIN, percent: 70 });
    expect(await ledger.latestPayout('A', T0 - 1)).toBeNull();
    expect(await ledger.latestPayout('A', T0)).toEqual({ asset: 'A', ts: T0, percent: 85 });
    expect(await ledger.latestPayout('A', T0 + MIN - 1)).toMatchObject({ percent: 85 });
    expect(await ledger.latestPayout('A', T0 + HOUR)).toMatchObject({ percent: 90 });
    expect(await ledger.latestPayout('B', T0 + HOUR)).toMatchObject({ percent: 70 });
    expect((await ledger.payoutsPage('A', T0, 10)).map((p) => p.percent)).toEqual([90]);
  });

  it('stores feed structure records', async () => {
    const r = { asset: 'A', ts: T0, label: 'none' as const, strength: 0, autocorr: [0, 0, 0, 0, 0], varianceRatio: 1, runsZ: 0, streakReversalRate: 0.5 };
    await ledger.putFeedStructure(r);
    await ledger.putFeedStructure({ ...r, strength: 0.3 });
    const exp = await ledger.export();
    expect(exp.feedStructure).toEqual([{ ...r, strength: 0.3 }]);
  });

  it('upserts patterns and lists them per asset oldest first', async () => {
    await ledger.putPattern(pattern('A', 'GRG', T0 + 2));
    await ledger.putPattern(pattern('A', 'GG', T0 + 1));
    await ledger.putPattern(pattern('B', 'RR', T0));
    await ledger.putPattern({ ...pattern('A', 'GRG', T0 + 2), status: 'validated', validatedAt: T0 + 5 });
    const a = await ledger.listPatterns('A');
    expect(a.map((p) => p.key)).toEqual(['GG', 'GRG']);
    expect(a[1]!.status).toBe('validated');
    expect(await ledger.listPatterns('C')).toEqual([]);
  });

  it('upserts engine stats per engine, asset and bucket including "all"', async () => {
    await ledger.putEngineStats(stats('pa', 'A', 3));
    await ledger.putEngineStats(stats('pa', 'A', 'all'));
    await ledger.putEngineStats(stats('pa', 'A', 3, 7));
    expect(await ledger.getEngineStats('pa', 'A', 3)).toMatchObject({ votes: 7 });
    expect(await ledger.getEngineStats('pa', 'A', 'all')).toMatchObject({ votes: 1 });
    expect(await ledger.getEngineStats('pa', 'B', 3)).toBeNull();
  });

  it('upserts engine state', async () => {
    expect(await ledger.getEngineState('pa')).toBeNull();
    await ledger.putEngineState({ engine: 'pa', ts: T0, state: { w: [1, 2] } });
    await ledger.putEngineState({ engine: 'pa', ts: T0 + 1, state: { w: [3] } });
    expect(await ledger.getEngineState('pa')).toEqual({ engine: 'pa', ts: T0 + 1, state: { w: [3] } });
  });
});

describe('prune', () => {
  it('keeps the tick retention per asset and 30 d of payouts and feed structure', async () => {
    const now = T0 + 10 * DAY;
    const R = TUNABLES.retentionTicksMs.value;
    await ledger.appendTicks([
      { asset: 'A', ts: now - R - HOUR, price: 1 },
      { asset: 'A', ts: now - R, price: 2 },
      { asset: 'A', ts: now - MIN, price: 3 },
      { asset: 'B', ts: now - R - 1, price: 4 },
    ]);
    await ledger.appendPayout({ asset: 'A', ts: now - 31 * DAY, percent: 80 });
    await ledger.appendPayout({ asset: 'A', ts: now - 29 * DAY, percent: 81 });
    const fs = { label: 'none' as const, strength: 0, autocorr: [0], varianceRatio: 1, runsZ: 0, streakReversalRate: 0.5 };
    await ledger.putFeedStructure({ ...fs, asset: 'A', ts: now - 31 * DAY });
    await ledger.putFeedStructure({ ...fs, asset: 'B', ts: now - DAY });
    await ledger.prune(now);
    expect((await ledger.getTicks('A')).map((t) => t.price)).toEqual([2, 3]);
    expect(await ledger.getTicks('B')).toEqual([]);
    expect((await ledger.export()).payouts.map((p) => p.percent)).toEqual([81]);
    expect((await ledger.export()).feedStructure.map((r) => r.asset)).toEqual(['B']);
  });

  it('thins 1m candles older than 30 d into 5m aggregates and leaves everything else alone', async () => {
    const now = T0 + 40 * DAY;
    const old = T0; // 40 days back, aligned to 5m
    for (let i = 0; i < 10; i++) {
      await ledger.putCandle(candle('A', old + i * MIN, 'rebuilt', { open: i, high: i + 1, low: i - 1, close: i + 0.5, tickCount: 1 }));
    }
    await ledger.putCandle(candle('A', now - DAY, 'rebuilt'));
    await ledger.putCandle(candle('A', old, 'feed', { tf: '5m', open: 42 }));
    await ledger.putCandle(candle('A', old, 'rebuilt', { tf: '2m' }));
    const v = vote({ engine: 'null', asset: 'A', candleOpenTs: old });
    await ledger.appendVote(v);
    await ledger.appendOutcome(outcome(v.voteId));
    await ledger.appendSignal(signal('A', old, old));
    await ledger.appendEvent({ ts: old, kind: 'info', payload: {} });
    await ledger.putPattern(pattern('A', 'GG', old));

    await ledger.prune(now);

    expect((await ledger.getCandles('A', '1m')).map((c) => c.openTs)).toEqual([now - DAY]);
    const fives = await ledger.getCandles('A', '5m');
    // The existing feed 5m candle wins over the rebuilt aggregate; the second bucket is new.
    expect(fives).toEqual([
      candle('A', old, 'feed', { tf: '5m', open: 42 }),
      { asset: 'A', isOTC: false, tf: '5m', openTs: old + 5 * MIN, open: 5, high: 10, low: 4, close: 9.5, tickCount: 5, source: 'rebuilt' },
    ]);
    expect(await ledger.getCandles('A', '2m')).toHaveLength(1);
    const exp = await ledger.export();
    expect(exp.votes).toHaveLength(1);
    expect(exp.outcomes).toHaveLength(1);
    expect(exp.signals).toHaveLength(1);
    expect(exp.events).toHaveLength(1);
    expect(exp.patterns).toHaveLength(1);
  });

  it('does not thin a 5m bucket that straddles the cutoff', async () => {
    const now = T0 + 30 * DAY + 2 * MIN; // cutoff = T0 + 2m, inside the bucket starting at T0
    for (let i = 0; i < 5; i++) await ledger.putCandle(candle('A', T0 + i * MIN, 'rebuilt'));
    await ledger.prune(now);
    expect(await ledger.getCandles('A', '1m')).toHaveLength(5);
    expect(await ledger.getCandles('A', '5m')).toEqual([]);
  });
});

describe('export', () => {
  it('returns every store sorted by key, ticks only on request, and is stable', async () => {
    await ledger.appendVote(vote({ engine: 'z', asset: 'B', candleOpenTs: T0 }));
    await ledger.appendVote(vote({ engine: 'a', asset: 'A', candleOpenTs: T0 + MIN }));
    await ledger.appendOutcome(outcome('b'));
    await ledger.appendOutcome(outcome('a'));
    await ledger.putCandle(candle('B', T0, 'rebuilt'));
    await ledger.putCandle(candle('A', T0 + MIN, 'rebuilt'));
    await ledger.putCandle(candle('A', T0, 'rebuilt'));
    await ledger.putEngineStats(stats('pa', 'A', 'all'));
    await ledger.putEngineStats(stats('pa', 'A', 10));
    await ledger.putEngineStats(stats('pa', 'A', 2));
    await ledger.appendTicks([{ asset: 'A', ts: 2, price: 1 }, { asset: 'A', ts: 1, price: 1 }]);
    await ledger.appendRawFrames([{ receivedAt: 1, tabId: 1, socketUrl: 'x', dir: 'in', encoding: 'text', data: 'x' }]);

    const exp = await ledger.export();
    expect(exp.format).toBe('bbqx-ledger');
    expect(exp.version).toBe(1);
    expect(exp.ticks).toBeUndefined();
    expect(exp.votes.map((v) => v.voteId)).toEqual([voteIdOf('A', '1m', T0 + MIN, 'a'), voteIdOf('B', '1m', T0, 'z')]);
    expect(exp.events).toEqual([]);
    expect(exp.outcomes.map((o) => o.voteId)).toEqual(['a', 'b']);
    expect(exp.candles.map((c) => `${c.asset}@${c.openTs - T0}`)).toEqual(['A@0', `A@${MIN}`, 'B@0']);
    // IndexedDB key order: numbers before strings.
    expect(exp.engineStats.map((s) => s.bucket)).toEqual([2, 10, 'all']);
    expect(Object.keys(exp)).not.toContain('rawFrames');

    const withTicks = await ledger.export({ includeTicks: true });
    expect(withTicks.ticks!.map((t) => t.ts)).toEqual([1, 2]);
    expect(JSON.stringify(await ledger.export())).toBe(JSON.stringify(exp));
  });

  it('persists across reopen', async () => {
    const name = `bbqx-reopen-${dbCounter}`;
    const a = await openIndexedDbLedger(name);
    await a.appendEvent({ ts: 1, kind: 'reload', payload: {} });
    a.close();
    const b = await openIndexedDbLedger(name);
    expect(await b.listEvents({})).toHaveLength(1);
    const next = await b.appendEvent({ ts: 2, kind: 'reload', payload: {} });
    expect(next).toBeGreaterThan((await b.listEvents({}))[0]!.seq);
  });
});
