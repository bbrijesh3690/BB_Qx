// The pipeline: market events in, ledger records out.
//
// Time comes only from event timestamps (ticks and clock events). On each such event the pipeline
// first runs every action that came due up to that time, in time order (candle closes, then
// scoring, then freezes when times tie), and only then applies the event. So a freeze at F sees
// exactly the data with ts < F, and nothing that arrived after time passed F.
//
// Per asset with a forming candle, at F = candleCloseAt - freezeBeforeCloseMs:
//   1. feed-structure engines run structure(ctx); the result is stored and becomes ctx.feed;
//   2. every other engine votes (or is forced to ABSTAIN: 'warmup', or an error it threw);
//   3. one VoteRecord per engine is appended. The vote predicts the candle opening at candleCloseAt.
// When that predicted candle has closed and confirmDelayMs has passed, UP/DOWN votes are scored from
// the feed candle if one arrived, else the rebuilt one; engines get onOutcome() with the frozen ctx
// and their state is persisted. A predicted candle that never formed leaves its votes unscored.
//
// An asset that had no forming candle when time passed F (its first tick came later) gets no vote
// for that candle. A late freeze (no event between F and the close) still uses only data before F;
// its VoteRecord.ts shows when it was written.

import {
  bucketOf, isFeedStructureEngine, TF_MS, voteIdOf,
  type Candle, type CandleRecord, type Context, type Engine, type EventKind, type FeedStructure, type FeedStructureEngine, type Ledger,
  type MarketEvent, type MarketEventSink, type Outcome, type PayoutRecord, type Tick, type TickRecord, type Timeframe, type Vote, type VoteRecord,
  NEUTRAL_FEED,
} from './contracts';
import { CandleBuilder, isValidCandle } from './candles';
import { sessionOf } from './time';
import { TUNABLES } from './tunables';

export interface PipelineOptions {
  ledger: Ledger;
  engines: Engine[];
  tf?: Timeframe;
  freezeBeforeCloseMs?: number;
  confirmDelayMs?: number;
  /** Closed candles passed in Context. */
  contextCandles?: number;
  /** Payout used for an asset until its first payout event. */
  defaultPayoutPercent?: number;
  tickBatchSize?: number;
  candleMismatchRelTol?: number;
  /** Drop the first candle per asset when it started before the pipeline did (see CandleBuilder). */
  partialStartToleranceMs?: number;
}

interface AssetRuntime {
  asset: string;
  isOTC: boolean;
  formingOpenTs: number | null;
  /** The freeze for the forming candle has run, or was skipped because the candle began after F. */
  frozen: boolean;
  feed: FeedStructure;
  /** Payout history, ascending ts; trimmed as freezes move forward. */
  payouts: { ts: number; percent: number }[];
}

interface PendingVote { engine: Engine; vote: Vote; record: VoteRecord }

interface PendingScore {
  asset: string;
  predictedOpenTs: number;
  dueAt: number;
  ctx: Context;
  votes: PendingVote[];
}

type Action = { t: number; rank: number; run: () => Promise<void> };

const DIRECTIONS = new Set(['UP', 'DOWN', 'ABSTAIN']);
const FEED_LABELS = new Set(['mean-reverting', 'trending', 'none']);

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class Pipeline implements MarketEventSink {
  readonly tf: Timeframe;
  readonly builder: CandleBuilder;
  private readonly ledger: Ledger;
  private readonly tfMs: number;
  private readonly freezeMs: number;
  private readonly confirmMs: number;
  private readonly contextCandles: number;
  private readonly defaultPayout: number;
  private readonly tickBatch: number;
  private readonly structureEngines: FeedStructureEngine[];
  private readonly voters: Engine[];
  private readonly assets = new Map<string, AssetRuntime>();
  private pending: PendingScore[] = [];
  private tickBuffer: TickRecord[] = [];
  private clock = -Infinity;

  constructor(opts: PipelineOptions) {
    this.ledger = opts.ledger;
    this.tf = opts.tf ?? '1m';
    this.tfMs = TF_MS[this.tf];
    this.freezeMs = opts.freezeBeforeCloseMs ?? TUNABLES.freezeBeforeCloseMs.value; // TUNABLE: freezeBeforeCloseMs
    this.confirmMs = opts.confirmDelayMs ?? TUNABLES.confirmDelayMs.value; // TUNABLE: confirmDelayMs
    this.contextCandles = opts.contextCandles ?? TUNABLES.contextCandles.value; // TUNABLE: contextCandles
    this.defaultPayout = opts.defaultPayoutPercent ?? TUNABLES.defaultPayoutPercent.value; // TUNABLE: defaultPayoutPercent
    this.tickBatch = opts.tickBatchSize ?? TUNABLES.tickBatchSize.value; // TUNABLE: tickBatchSize
    if (!(this.freezeMs > 0 && this.freezeMs < this.tfMs)) throw new Error(`pipeline: freezeBeforeCloseMs must be in (0, ${this.tfMs})`);
    if (!(this.confirmMs >= 0)) throw new Error('pipeline: confirmDelayMs must be >= 0');

    const ids = new Set<string>();
    for (const e of opts.engines) {
      if (ids.has(e.id)) throw new Error(`pipeline: duplicate engine id '${e.id}'`);
      ids.add(e.id);
      if (e.warmupCandles > this.contextCandles)
        throw new Error(`pipeline: engine '${e.id}' needs ${e.warmupCandles} candles but Context holds ${this.contextCandles}`);
    }
    this.structureEngines = opts.engines.filter(isFeedStructureEngine);
    this.voters = opts.engines.filter((e) => !isFeedStructureEngine(e));
    this.builder = new CandleBuilder({
      tf: this.tf,
      historyCap: this.contextCandles,
      ...(opts.candleMismatchRelTol !== undefined ? { mismatchRelTol: opts.candleMismatchRelTol } : {}),
      ...(opts.partialStartToleranceMs !== undefined ? { partialStartToleranceMs: opts.partialStartToleranceMs } : {}),
    });
  }

  /** Server time as far as the pipeline knows it. */
  get now(): number {
    return this.clock;
  }

  /** Votes waiting for their predicted candle. */
  get pendingCount(): number {
    return this.pending.length;
  }

  async onEvent(ev: MarketEvent): Promise<void> {
    switch (ev.kind) {
      case 'tick':
        await this.advanceTo(ev.ts);
        await this.applyTick(ev.asset, ev.isOTC, ev.ts, ev.price);
        return;
      case 'clock':
        await this.advanceTo(ev.ts);
        return;
      case 'payout':
        if (!Number.isFinite(ev.percent) || !Number.isFinite(ev.ts)) return;
        this.applyPayout(ev.asset, ev.isOTC, ev.ts, ev.percent);
        await this.ledger.appendPayout({ asset: ev.asset, ts: ev.ts, percent: ev.percent });
        return;
      case 'candle':
        if (!isValidCandle(ev.candle, ev.tf)) return;
        this.runtime(ev.asset, ev.isOTC);
        this.builder.onFeedCandle(ev.asset, ev.isOTC, ev.tf, ev.candle);
        await this.ledger.putCandle({ asset: ev.asset, isOTC: ev.isOTC, tf: ev.tf, ...ev.candle, source: 'feed' });
        await this.drainBuilder();
        return;
    }
  }

  /**
   * Restores an asset's stored candles and latest payout after a restart, so engines don't start
   * their warmup again. Writes nothing to the ledger. Call before any event for that asset.
   */
  preload(asset: string, isOTC: boolean, candles: readonly CandleRecord[], payout: PayoutRecord | null): void {
    this.runtime(asset, isOTC);
    this.builder.preload(asset, isOTC, candles.filter((c) => c.tf === this.tf).map((c) => ({ candle: c, source: c.source })));
    if (payout && Number.isFinite(payout.percent)) this.applyPayout(asset, isOTC, payout.ts, payout.percent);
  }

  /** Writes buffered ticks. Call at the end of a run. Votes whose candle has not closed stay unscored. */
  async flush(): Promise<void> {
    await this.drainBuilder();
    await this.flushTicks();
  }

  // ---------------------------------------------------------------------------
  // Time
  // ---------------------------------------------------------------------------

  private async advanceTo(T: number): Promise<void> {
    if (!(T > this.clock)) return;
    this.clock = T;
    for (;;) {
      const next = this.nextAction(T);
      if (!next) break;
      this.builder.advance(next.t);
      await this.drainBuilder();
      await next.run();
    }
    this.builder.advance(T);
    await this.drainBuilder();
  }

  /** Earliest action due at or before T. Ties: close (0), then score (1), then freeze (2). */
  private nextAction(T: number): Action | null {
    let best: Action | null = null;
    const consider = (a: Action) => {
      if (a.t <= T && (!best || a.t < best.t || (a.t === best.t && a.rank < best.rank))) best = a;
    };
    for (const rt of this.assets.values()) {
      const fo = this.builder.formingOpenTs(rt.asset);
      if (fo === null) continue;
      const closeAt = fo + this.tfMs;
      consider({ t: closeAt, rank: 0, run: async () => {} }); // builder.advance(t) does the closing
      if (!rt.frozen) consider({ t: closeAt - this.freezeMs, rank: 2, run: () => this.freeze(rt, fo, closeAt - this.freezeMs) });
    }
    const head = this.pending[0];
    if (head) consider({ t: head.dueAt, rank: 1, run: () => this.scoreDue(head.dueAt) });
    return best;
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  private runtime(asset: string, isOTC: boolean): AssetRuntime {
    let rt = this.assets.get(asset);
    if (!rt) {
      rt = { asset, isOTC, formingOpenTs: null, frozen: false, feed: NEUTRAL_FEED, payouts: [] };
      this.assets.set(asset, rt);
    }
    return rt;
  }

  private async applyTick(asset: string, isOTC: boolean, ts: number, price: number): Promise<void> {
    const rt = this.runtime(asset, isOTC);
    if (!this.builder.onTick(asset, rt.isOTC, ts, price)) return;
    this.tickBuffer.push({ asset, ts, price });
    const fo = this.builder.formingOpenTs(asset);
    if (fo !== rt.formingOpenTs) {
      rt.formingOpenTs = fo;
      // A candle that only began at or after its freeze time existed nowhere at F: no vote for it.
      rt.frozen = fo !== null && this.clock >= fo + this.tfMs - this.freezeMs;
    }
    await this.drainBuilder();
    if (this.tickBuffer.length >= this.tickBatch) await this.flushTicks();
  }

  private applyPayout(asset: string, isOTC: boolean, ts: number, percent: number): void {
    const list = this.runtime(asset, isOTC).payouts;
    let i = list.length;
    while (i > 0 && list[i - 1]!.ts > ts) i--;
    if (i > 0 && list[i - 1]!.ts === ts) list[i - 1] = { ts, percent };
    else list.splice(i, 0, { ts, percent });
  }

  /** Latest payout strictly before F, as a fraction. */
  private payoutAt(rt: AssetRuntime, F: number): number {
    const list = rt.payouts;
    let i = list.length - 1;
    while (i >= 0 && list[i]!.ts >= F) i--;
    if (i < 0) return this.defaultPayout / 100;
    if (i > 0) list.splice(0, i); // older entries can no longer be the answer: F only moves forward
    return list[0]!.percent / 100;
  }

  private async flushTicks(): Promise<void> {
    if (!this.tickBuffer.length) return;
    const batch = this.tickBuffer;
    this.tickBuffer = [];
    await this.ledger.appendTicks(batch);
  }

  private async drainBuilder(): Promise<void> {
    for (const e of this.builder.drain()) {
      if (e.kind === 'closed') {
        await this.ledger.putCandle(e.candle);
      } else if (e.kind === 'gap') {
        await this.log('feed_gap', e.asset, undefined, {
          reason: 'no ticks', tf: e.tf, fromOpenTs: e.fromOpenTs, toOpenTs: e.toOpenTs, missing: e.missing,
        });
      } else {
        await this.log('candle_mismatch', e.asset, undefined, {
          tf: e.tf, openTs: e.openTs, feed: e.feed, rebuilt: e.rebuilt, maxRelDiff: e.maxRelDiff, colourDiffers: e.colourDiffers,
        });
      }
    }
  }

  private async log(kind: EventKind, asset: string | undefined, engine: string | undefined, payload: Record<string, unknown>): Promise<void> {
    await this.ledger.appendEvent({
      ts: this.clock, kind,
      ...(asset !== undefined ? { asset } : {}),
      ...(engine !== undefined ? { engine } : {}),
      payload,
    });
  }

  // ---------------------------------------------------------------------------
  // Freeze and vote
  // ---------------------------------------------------------------------------

  private async freeze(rt: AssetRuntime, fo: number, F: number): Promise<void> {
    rt.frozen = true;
    const ticks = this.builder.formingTicks(rt.asset).filter((t) => t.ts < F);
    if (ticks.length === 0) return;
    const closeAt = fo + this.tfMs;
    const payout = this.payoutAt(rt, F);
    const base = {
      asset: rt.asset, isOTC: rt.isOTC, tf: this.tf,
      candles: Object.freeze(this.builder.closed(rt.asset).slice(-this.contextCandles)) as Candle[],
      forming: Object.freeze(candleOf(fo, ticks)) as Candle,
      ticks: Object.freeze(ticks) as Tick[],
      now: F, candleCloseAt: closeAt, payout,
      session: Object.freeze(sessionOf(closeAt, rt.isOTC)),
    };

    let feed = rt.feed;
    let structured = false;
    for (const fs of this.structureEngines) {
      try {
        const result = fs.structure(Object.freeze({ ...base, feed }));
        if (!isValidFeed(result)) throw new Error('invalid FeedStructure');
        feed = freezeFeed(result);
        structured = true;
      } catch (err) {
        await this.log('info', rt.asset, fs.id, { phase: 'structure', error: errorText(err) });
      }
    }
    if (structured) {
      rt.feed = feed;
      await this.ledger.putFeedStructure({ asset: rt.asset, ts: F, ...feed, autocorr: [...feed.autocorr] });
    }
    const ctx: Context = Object.freeze({ ...base, feed });

    const votes: PendingVote[] = [];
    for (const engine of this.voters) {
      let vote: Vote;
      if (ctx.candles.length < engine.warmupCandles) {
        vote = abstain(engine.id, 'warmup');
      } else {
        try {
          vote = engine.vote(ctx);
          const problem = voteProblem(vote);
          if (problem) throw new Error(`invalid vote: ${problem}`);
        } catch (err) {
          vote = abstain(engine.id, `error: ${errorText(err)}`);
          await this.log('info', rt.asset, engine.id, { phase: 'vote', error: errorText(err), candleOpenTs: closeAt });
        }
      }
      const record: VoteRecord = {
        voteId: voteIdOf(rt.asset, this.tf, closeAt, engine.id),
        ts: this.clock,
        asset: rt.asset, isOTC: rt.isOTC, tf: this.tf, candleOpenTs: closeAt, bucket: bucketOf(closeAt),
        engine: engine.id, direction: vote.direction, confidence: vote.confidence, reasons: [...vote.reasons],
        ...(vote.features !== undefined ? { features: { ...vote.features } } : {}),
        payoutAtVote: payout, frozenAt: F,
      };
      await this.ledger.appendVote(record);
      votes.push({ engine, vote, record });
    }
    this.pending.push({ asset: rt.asset, predictedOpenTs: closeAt, dueAt: closeAt + this.tfMs + this.confirmMs, ctx, votes });
  }

  // ---------------------------------------------------------------------------
  // Scoring
  // ---------------------------------------------------------------------------

  private async scoreDue(t: number): Promise<void> {
    const touched = new Set<Engine>();
    while (this.pending.length && this.pending[0]!.dueAt === t) {
      const p = this.pending.shift()!;
      const directional = p.votes.filter((v) => v.record.direction !== 'ABSTAIN');
      const found = this.builder.closedCandle(p.asset, p.predictedOpenTs);
      if (!found) {
        if (directional.length)
          await this.log('feed_gap', p.asset, undefined, {
            reason: 'predicted candle missing', tf: this.tf, openTs: p.predictedOpenTs, unscored: directional.length,
          });
        continue;
      }
      const c = found.candle;
      for (const v of directional) {
        const result = scoreOf(v.record.direction, c);
        await this.ledger.appendOutcome({ voteId: v.record.voteId, result, openPrice: c.open, closePrice: c.close, scoredAt: this.clock });
        try {
          v.engine.onOutcome(v.vote, result, p.ctx);
        } catch (err) {
          await this.log('info', p.asset, v.engine.id, { phase: 'onOutcome', error: errorText(err) });
        }
        touched.add(v.engine);
      }
    }
    for (const engine of touched) {
      try {
        await this.ledger.putEngineState({ engine: engine.id, ts: this.clock, state: engine.serialize() });
      } catch (err) {
        await this.log('info', undefined, engine.id, { phase: 'serialize', error: errorText(err) });
      }
    }
  }
}

/** TIE when the predicted candle closed where it opened; otherwise WIN when the direction matched. */
export function scoreOf(direction: 'UP' | 'DOWN' | 'ABSTAIN', c: Candle): Outcome {
  if (c.close === c.open) return 'TIE';
  return (c.close > c.open) === (direction === 'UP') ? 'WIN' : 'LOSS';
}

function candleOf(openTs: number, ticks: readonly Tick[]): Candle {
  let high = -Infinity, low = Infinity;
  for (const t of ticks) {
    if (t.price > high) high = t.price;
    if (t.price < low) low = t.price;
  }
  return { openTs, open: ticks[0]!.price, high, low, close: ticks[ticks.length - 1]!.price, tickCount: ticks.length };
}

function abstain(engine: string, reason: string): Vote {
  return { engine, direction: 'ABSTAIN', confidence: 0.5, reasons: [reason] };
}

function voteProblem(v: Vote): string | null {
  if (!v || typeof v !== 'object') return 'not an object';
  if (!DIRECTIONS.has(v.direction)) return `direction ${String(v.direction)}`;
  if (!(Number.isFinite(v.confidence) && v.confidence >= 0.5 && v.confidence <= 1)) return `confidence ${String(v.confidence)}`;
  if (!Array.isArray(v.reasons) || !v.reasons.every((r) => typeof r === 'string')) return 'reasons must be strings';
  if (v.features !== undefined && (typeof v.features !== 'object' || !Object.values(v.features).every((x) => typeof x === 'number')))
    return 'features must be numbers';
  return null;
}

function isValidFeed(f: FeedStructure): boolean {
  return !!f && FEED_LABELS.has(f.label) && Number.isFinite(f.strength) && Array.isArray(f.autocorr) &&
    f.autocorr.every(Number.isFinite) && Number.isFinite(f.varianceRatio) && Number.isFinite(f.runsZ) &&
    Number.isFinite(f.streakReversalRate);
}

function freezeFeed(f: FeedStructure): FeedStructure {
  return Object.freeze({
    label: f.label, strength: f.strength, autocorr: Object.freeze([...f.autocorr]) as number[],
    varianceRatio: f.varianceRatio, runsZ: f.runsZ, streakReversalRate: f.streakReversalRate,
  });
}
