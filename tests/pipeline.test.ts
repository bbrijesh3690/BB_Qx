import { describe, expect, it } from 'vitest';
import {
  NEUTRAL_FEED, voteIdOf,
  type Context, type Direction, type Engine, type EngineStats, type FeedStructure, type FeedStructureEngine,
  type MarketEvent, type Outcome, type Vote,
} from '../src/core/contracts';
import { Pipeline } from '../src/core/pipeline';
import { Rng } from '../src/core/rng';
import { MemoryLedger } from '../src/ledger/memory';

const T = Date.UTC(2026, 0, 5, 10, 0); // Monday 10:00 UTC, minute-aligned
const S = 1000, M = 60_000;
const A = 'EURUSD_otc', B = 'GBPUSD';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tick = (asset: string, ts: number, price: number, isOTC = asset.endsWith('_otc')): MarketEvent =>
  ({ kind: 'tick', asset, isOTC, ts, price });

/** Twelve ticks every 5 s from openTs, moving linearly from open to close (last tick at +55 s). */
function minute(asset: string, openTs: number, open: number, close: number): MarketEvent[] {
  return Array.from({ length: 12 }, (_, i) => tick(asset, openTs + i * 5 * S, open + ((close - open) * i) / 11));
}

/** Consecutive minutes from T; each candle opens at the previous close. */
function minutes(asset: string, closes: number[], start = 1.1, from = T): MarketEvent[] {
  const out: MarketEvent[] = [];
  let open = start;
  closes.forEach((close, i) => {
    out.push(...minute(asset, from + i * M, open, close));
    open = close;
  });
  return out;
}

/** Merge event lists by ts, keeping list order for equal ts. */
function merge(...lists: MarketEvent[][]): MarketEvent[] {
  const ts = (e: MarketEvent) => (e.kind === 'candle' ? e.candle.openTs : e.ts);
  return lists.flat().map((e, i) => ({ e, i })).sort((a, b) => ts(a.e) - ts(b.e) || a.i - b.i).map((x) => x.e);
}

interface Spy extends Engine {
  ctxs: Context[];
  outcomes: { vote: Vote; outcome: Outcome; ctx: Context }[];
}

interface SpyOptions {
  dir?: (ctx: Context) => Direction;
  warmup?: number;
  confidence?: number;
  voteThrows?: (ctx: Context) => boolean;
  outcomeThrows?: boolean;
  kind?: Engine['kind'];
}

function spy(id: string, o: SpyOptions = {}): Spy {
  const s: Spy = {
    id, kind: o.kind ?? 'direction', warmupCandles: o.warmup ?? 0, ctxs: [], outcomes: [],
    vote(ctx) {
      s.ctxs.push(ctx);
      if (o.voteThrows?.(ctx)) throw new Error('boom');
      return { engine: id, direction: o.dir ? o.dir(ctx) : 'UP', confidence: o.confidence ?? 0.6, reasons: ['spy'], features: { n: ctx.candles.length } };
    },
    onOutcome(vote, outcome, ctx) {
      s.outcomes.push({ vote, outcome, ctx });
      if (o.outcomeThrows) throw new Error('learning failed');
    },
    stats: (): EngineStats => ({ votes: 0, abstains: 0, hits: 0, ties: 0, last100: null, last200: null, brier: null, killed: false }),
    serialize: () => ({ seen: s.outcomes.length }),
    restore: () => {},
  };
  return s;
}

async function runEvents(engines: Engine[], events: MarketEvent[], extra: Partial<ConstructorParameters<typeof Pipeline>[0]> = {}) {
  const ledger = new MemoryLedger();
  const p = new Pipeline({ ledger, engines, ...extra });
  for (const e of events) await p.onEvent(e);
  await p.flush();
  return { ledger, p };
}

// ---------------------------------------------------------------------------

describe('Pipeline: freeze', () => {
  it('freezes at T-5s, predicts the next candle, and the context holds only data from before the freeze', async () => {
    const e = spy('s');
    const { ledger } = await runEvents([e], minutes(A, [1.2, 1.1, 1.3, 1.25]));
    const votes = (await ledger.queryVotes({ engine: 's' })).map((r) => r.vote);
    expect(votes.map((v) => v.candleOpenTs)).toEqual([T + M, T + 2 * M, T + 3 * M, T + 4 * M]);
    const v0 = votes[0]!;
    expect(v0).toMatchObject({
      voteId: voteIdOf(A, '1m', T + M, 's'), asset: A, isOTC: true, tf: '1m', bucket: 10,
      frozenAt: T + 55 * S, ts: T + 55 * S, direction: 'UP', confidence: 0.6, reasons: ['spy'], features: { n: 0 },
    });
    const ctx = e.ctxs[0]!;
    expect(ctx.now).toBe(T + 55 * S);
    expect(ctx.candleCloseAt).toBe(T + M);
    expect(ctx.ticks).toHaveLength(11); // the tick at exactly T+55s is not in it
    expect(ctx.forming).toEqual({ openTs: T, open: 1.1, high: ctx.ticks[10]!.price, low: 1.1, close: ctx.ticks[10]!.price, tickCount: 11 });
    expect(ctx.candles).toEqual([]);
    expect(e.ctxs[2]!.candles.map((c) => c.openTs)).toEqual([T, T + M]);
    expect(e.ctxs[2]!.candles[1]).toMatchObject({ open: 1.2, close: 1.1, tickCount: 12 });
    expect(ctx.session).toEqual({ hourUtc: 10, dayOfWeek: 1, isOTC: true, marketOpen: true });
    expect(ctx.feed).toEqual(NEUTRAL_FEED);
  });

  it('never shows an engine a tick at or after frozenAt, or the candle it predicts (random two-asset feed)', async () => {
    const rng = new Rng(11);
    const evs: MarketEvent[] = [];
    const price: Record<string, number> = { [A]: 1.1, [B]: 1.3 };
    for (let t = T; t < T + 60 * M; t += 700 + rng.int(3000)) {
      const asset = rng.next() < 0.5 ? A : B;
      price[asset] = Math.round((price[asset]! + rng.normal(0, 0.0002)) * 1e5) / 1e5;
      evs.push(tick(asset, t, price[asset]!));
      if (rng.next() < 0.05) evs.push({ kind: 'clock', ts: t + 1 });
    }
    const e = spy('s', { dir: (ctx) => (ctx.ticks.length % 2 ? 'UP' : 'DOWN') });
    const { ledger } = await runEvents([e], evs);
    expect(e.ctxs.length).toBeGreaterThan(80);
    for (const ctx of e.ctxs) {
      const formingOpen = ctx.candleCloseAt - M;
      expect(ctx.now).toBe(ctx.candleCloseAt - 5 * S);
      expect(ctx.ticks.length).toBeGreaterThan(0);
      for (const t of ctx.ticks) {
        expect(t.ts).toBeLessThan(ctx.now);
        expect(t.ts).toBeGreaterThanOrEqual(formingOpen);
      }
      expect(ctx.forming!.openTs).toBe(formingOpen);
      for (const c of ctx.candles) expect(c.openTs).toBeLessThan(formingOpen);
      expect(ctx.candles.some((c) => c.openTs === ctx.candleCloseAt)).toBe(false);
      expect(Object.isFrozen(ctx) && Object.isFrozen(ctx.candles) && Object.isFrozen(ctx.ticks)).toBe(true);
    }
    for (const { vote } of await ledger.queryVotes({})) {
      expect(vote.frozenAt).toBe(vote.candleOpenTs - 5 * S);
      expect(vote.ts).toBeGreaterThanOrEqual(vote.frozenAt);
    }
    // onOutcome gets the very context the vote was made with.
    expect(e.outcomes.length).toBeGreaterThan(50);
    for (const o of e.outcomes) expect(e.ctxs).toContain(o.ctx);
  });

  it('a late freeze (no event between F and the close) still uses only ticks before F', async () => {
    const e = spy('s');
    const evs = [...minute(A, T, 1.1, 1.2).slice(0, 11), tick(A, T + M + S, 1.21), tick(A, T + M + 30 * S, 1.22)];
    const { ledger } = await runEvents([e], evs);
    const [v] = (await ledger.queryVotes({})).map((r) => r.vote);
    expect(v).toMatchObject({ candleOpenTs: T + M, frozenAt: T + 55 * S, ts: T + M + S });
    expect(e.ctxs[0]!.ticks.map((t) => t.ts)).toEqual(Array.from({ length: 11 }, (_, i) => T + i * 5 * S));
  });

  it('gives no vote for a candle whose first tick came at or after its freeze time', async () => {
    const e = spy('s');
    const evs = merge(minute(B, T, 1.3, 1.31), [tick(A, T + 57 * S, 1.1)], minute(A, T + M, 1.1, 1.2), minute(B, T + M, 1.31, 1.32));
    const { ledger } = await runEvents([e], evs);
    const aVotes = (await ledger.queryVotes({ asset: A })).map((r) => r.vote.candleOpenTs);
    expect(aVotes).toEqual([T + 2 * M]);
    expect((await ledger.queryVotes({ asset: B })).map((r) => r.vote.candleOpenTs)).toEqual([T + M, T + 2 * M]);
  });

  it('forces ABSTAIN with reason warmup until the engine has its candles, without calling it', async () => {
    const e = spy('s', { warmup: 2 });
    const { ledger } = await runEvents([e], minutes(A, [1.2, 1.1, 1.3, 1.25]));
    const votes = (await ledger.queryVotes({})).map((r) => r.vote);
    expect(votes.map((v) => v.direction)).toEqual(['ABSTAIN', 'ABSTAIN', 'UP', 'UP']);
    expect(votes[0]).toMatchObject({ reasons: ['warmup'], confidence: 0.5 });
    expect(e.ctxs.map((c) => c.candles.length)).toEqual([2, 3]);
    expect(await ledger.getOutcome(votes[0]!.voteId)).toBeNull();
  });

  it('rejects duplicate engine ids and warmups longer than the context', () => {
    const ledger = new MemoryLedger();
    expect(() => new Pipeline({ ledger, engines: [spy('x'), spy('x')] })).toThrow(/duplicate/);
    expect(() => new Pipeline({ ledger, engines: [spy('x', { warmup: 50 })], contextCandles: 10 })).toThrow(/needs 50/);
    expect(() => new Pipeline({ ledger, engines: [], freezeBeforeCloseMs: 0 })).toThrow(/freezeBeforeCloseMs/);
  });
});

describe('Pipeline: scoring', () => {
  it('scores at close + confirm delay from the predicted candle: WIN, LOSS and TIE', async () => {
    const up = spy('up'), down = spy('down', { dir: () => 'DOWN' });
    const ledger = new MemoryLedger();
    const p = new Pipeline({ ledger, engines: [up, down] });
    // Candle 1 (predicted by the first freeze) closes up; candle 2 is a tie; candle 3 closes down.
    const evs = minutes(A, [1.15, 1.2, 1.2, 1.1, 1.12]);
    const voteId = voteIdOf(A, '1m', T + M, 'up');
    for (const ev of evs) {
      await p.onEvent(ev);
      const ts = ev.kind === 'tick' ? ev.ts : 0;
      if (ts === T + 2 * M) expect(await ledger.getOutcome(voteId)).toBeNull(); // closed, but not confirmed yet
      if (ts === T + 2 * M + 5 * S) expect(await ledger.getOutcome(voteId)).not.toBeNull();
    }
    await p.flush();
    const res = async (engine: string, k: number) => (await ledger.getOutcome(voteIdOf(A, '1m', T + k * M, engine)))!;
    expect(await res('up', 1)).toEqual({ voteId, result: 'WIN', openPrice: 1.15, closePrice: 1.2, scoredAt: T + 2 * M + 5 * S });
    expect((await res('down', 1)).result).toBe('LOSS');
    expect((await res('up', 2)).result).toBe('TIE');
    expect((await res('down', 2)).result).toBe('TIE');
    expect((await res('up', 3)).result).toBe('LOSS');
    expect((await res('down', 3)).result).toBe('WIN');
    expect(up.outcomes.map((o) => o.outcome)).toEqual(['WIN', 'TIE', 'LOSS']);
    // Votes for candle 5 never see their candle close: they stay unscored.
    expect(await ledger.getOutcome(voteIdOf(A, '1m', T + 5 * M, 'up'))).toBeNull();
  });

  it('scores from the feed candle when the feed reports one before the confirm delay', async () => {
    const e = spy('s');
    const evs = minutes(A, [1.2, 1.25, 1.3]);
    // Rebuilt candle 1 closes up (1.2 -> 1.25); the feed says it closed down at 1.19.
    const feedCandle: MarketEvent = { kind: 'candle', asset: A, isOTC: true, tf: '1m', candle: { openTs: T + M, open: 1.2, high: 1.26, low: 1.18, close: 1.19, tickCount: 40 } };
    const i = evs.findIndex((ev) => ev.kind === 'tick' && ev.ts === T + 2 * M);
    evs.splice(i + 1, 0, feedCandle);
    const { ledger } = await runEvents([e], evs);
    expect(await ledger.getOutcome(voteIdOf(A, '1m', T + M, 's'))).toMatchObject({ result: 'LOSS', openPrice: 1.2, closePrice: 1.19 });
    expect((await ledger.getCandles(A, '1m', { fromTs: T + M, toTs: T + 2 * M }))[0]).toMatchObject({ source: 'feed', close: 1.19 });
    expect((await ledger.listEvents({ kind: 'candle_mismatch' })).map((ev) => ev.payload.openTs)).toEqual([T + M]);
    // The next freeze already sees the feed version of candle 1.
    expect(e.ctxs[2]!.candles[1]).toMatchObject({ openTs: T + M, close: 1.19 });
  });

  it('leaves votes unscored and logs feed_gap when the predicted candle never forms', async () => {
    const e = spy('s');
    const clocks: MarketEvent[] = Array.from({ length: 200 }, (_, i) => ({ kind: 'clock', ts: T + 30 * S + i * S }));
    const evs = merge(minute(A, T, 1.1, 1.2), clocks, minute(A, T + 4 * M, 1.2, 1.3), minute(A, T + 5 * M, 1.3, 1.4), [{ kind: 'clock', ts: T + 6 * M + 3 * S }]);
    const { ledger } = await runEvents([e], evs);
    const gapVote = voteIdOf(A, '1m', T + M, 's');
    expect((await ledger.queryVotes({})).map((r) => r.vote.candleOpenTs)).toEqual([T + M, T + 5 * M, T + 6 * M]);
    expect(await ledger.getOutcome(gapVote)).toBeNull();
    const gaps = await ledger.listEvents({ kind: 'feed_gap' });
    expect(gaps.map((g) => g.payload.reason)).toEqual(['predicted candle missing', 'no ticks']);
    expect(gaps[0]).toMatchObject({ asset: A, ts: T + 2 * M + 2 * S, payload: { openTs: T + M, unscored: 1 } });
    expect(gaps[1]!.payload).toMatchObject({ fromOpenTs: T + M, toOpenTs: T + 4 * M, missing: 3 });
    expect(await ledger.getOutcome(voteIdOf(A, '1m', T + 5 * M, 's'))).toMatchObject({ result: 'WIN' });
    expect(e.outcomes).toHaveLength(1);
  });

  it('persists engine state after outcomes', async () => {
    const e = spy('s');
    const { ledger } = await runEvents([e], minutes(A, [1.2, 1.1, 1.3]));
    expect(await ledger.getEngineState('s')).toEqual({ engine: 's', ts: T + 2 * M + 5 * S, state: { seen: 1 } });
  });
});

describe('Pipeline: engine failures', () => {
  it('records a throwing engine as ABSTAIN with the error, logs it, and keeps the others running', async () => {
    const bad = spy('bad', { voteThrows: (ctx) => ctx.candles.length === 1 });
    const good = spy('good');
    const { ledger } = await runEvents([bad, good], minutes(A, [1.2, 1.1, 1.3, 1.4]));
    const badVotes = (await ledger.queryVotes({ engine: 'bad' })).map((r) => r.vote);
    expect(badVotes.map((v) => v.direction)).toEqual(['UP', 'ABSTAIN', 'UP', 'UP']);
    expect(badVotes[1]!.reasons).toEqual(['error: boom']);
    const info = await ledger.listEvents({ kind: 'info' });
    expect(info).toHaveLength(1);
    expect(info[0]).toMatchObject({ asset: A, engine: 'bad', payload: { phase: 'vote', error: 'boom' } });
    expect((await ledger.queryVotes({ engine: 'good', scoredOnly: true })).length).toBe(2);
  });

  it('treats an invalid vote as an error', async () => {
    const e = spy('weird', { confidence: 0.3 });
    const { ledger } = await runEvents([e], minutes(A, [1.2]));
    expect((await ledger.queryVotes({}))[0]!.vote).toMatchObject({ direction: 'ABSTAIN', reasons: ['error: invalid vote: confidence 0.3'] });
  });

  it('an engine that throws in onOutcome is logged; scoring and the other engines continue', async () => {
    const bad = spy('bad', { outcomeThrows: true }), good = spy('good');
    const { ledger } = await runEvents([bad, good], minutes(A, [1.2, 1.1, 1.3, 1.4]));
    expect((await ledger.queryVotes({ scoredOnly: true })).length).toBe(4);
    expect((await ledger.listEvents({ kind: 'info' })).map((e) => e.payload.phase)).toEqual(['onOutcome', 'onOutcome']);
    expect(good.outcomes).toHaveLength(2);
  });
});

describe('Pipeline: payouts and feed structure', () => {
  it('payoutAtVote is the latest payout strictly before the freeze, as a fraction; default until one is seen', async () => {
    const e = spy('s');
    const evs = merge(
      minutes(B, [1.31, 1.32, 1.33]),
      [{ kind: 'payout', asset: A, isOTC: true, ts: T, percent: 85 }],
      minutes(A, [1.2, 1.1, 1.3]),
      [{ kind: 'payout', asset: A, isOTC: true, ts: T + M + 55 * S, percent: 92 }], // exactly at the second freeze
    );
    const { ledger } = await runEvents([e], evs);
    const pay = async (asset: string) => (await ledger.queryVotes({ asset })).map((r) => r.vote.payoutAtVote);
    expect(await pay(A)).toEqual([0.85, 0.85, 0.92]);
    expect(await pay(B)).toEqual([0.8, 0.8, 0.8]);
    expect(await ledger.latestPayout(A, T + 10 * M)).toEqual({ asset: A, ts: T + M + 55 * S, percent: 92 });
  });

  it('runs feed-structure engines first, stores the result and passes it to every voter', async () => {
    const seen: FeedStructure[] = [];
    let n = 0;
    const fs: FeedStructureEngine = {
      ...spy('fs', { kind: 'context' }),
      kind: 'context',
      structure(ctx) {
        seen.push(ctx.feed);
        n++;
        return { label: n > 1 ? 'mean-reverting' : 'none', strength: n / 10, autocorr: [-0.04 * n, 0, 0, 0, 0], varianceRatio: 0.9, runsZ: 1, streakReversalRate: 0.53 };
      },
    };
    const voter = spy('v');
    const { ledger } = await runEvents([voter, fs], minutes(A, [1.2, 1.1, 1.3]));
    expect(seen[0]).toEqual(NEUTRAL_FEED);
    expect(seen[1]).toMatchObject({ label: 'none', strength: 0.1 });
    expect(voter.ctxs.map((c) => c.feed.strength)).toEqual([0.1, 0.2, 0.3]);
    expect((await ledger.queryVotes({})).map((r) => r.vote.engine)).toEqual(['v', 'v', 'v']);
    const stored = (await ledger.export()).feedStructure;
    expect(stored.map((r) => [r.asset, r.ts, r.label])).toEqual([[A, T + 55 * S, 'none'], [A, T + M + 55 * S, 'mean-reverting'], [A, T + 2 * M + 55 * S, 'mean-reverting']]);
  });
});

describe('Pipeline: ledger writes', () => {
  it('writes accepted ticks (batched), rebuilt candles and feed candles', async () => {
    const evs = minutes(A, [1.2, 1.1]);
    evs.splice(4, 0, tick(A, T + 10 * S, 9.9), tick(A, T + 7 * S, 9.9)); // after the T+15s tick: a duplicate, then an out-of-order tick
    const { ledger } = await runEvents([], evs, { tickBatchSize: 5 });
    const ticks = await ledger.getTicks(A);
    expect(ticks).toHaveLength(24);
    expect(ticks.some((t) => t.price === 9.9)).toBe(false);
    expect((await ledger.getCandles(A, '1m')).map((c) => [c.openTs, c.source, c.tickCount])).toEqual([[T, 'rebuilt', 12]]);
  });
});
