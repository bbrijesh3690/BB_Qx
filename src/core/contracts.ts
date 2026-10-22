// Frozen contracts for BB_Qx (Quorum). Owned by the lead; build agents never edit this file.
// If a contract seems wrong, report it to the lead instead of working around it.
//
// Sources in BB_Qx.md: Engine contract ("Data layer and interfaces"), Ledger API and
// Harness contract ("Agent split"), IndexedDB stores table.
//
// Conventions that hold everywhere:
// - Every timestamp is milliseconds since the Unix epoch, in SERVER time. Never the local clock,
//   except RawFrameRecord.receivedAt, which is the local receive time of a raw frame.
// - Payout appears in two forms: `percent` (0..100, as the platform shows it) in stored records,
//   and `payout` (a fraction, 0.85 for 85%) in Context and in break-even maths.
// - A vote predicts the NEXT candle: the one that opens at Context.candleCloseAt. It is frozen at
//   T-5s before the current candle closes and scored when that next candle closes:
//   WIN if its direction matches the vote, TIE if close == open, LOSS otherwise.
// - Code under src/core, src/engines, src/features, src/ledger/memory.ts and src/harness must be
//   deterministic: no Date.now(), Math.random() or performance.now(). Use src/core/rng.ts.

// ---------------------------------------------------------------------------
// Engine contract (BB_Qx.md, "Data layer and interfaces")
// ---------------------------------------------------------------------------

export type Direction = 'UP' | 'DOWN' | 'ABSTAIN';
export type Outcome = 'WIN' | 'LOSS' | 'TIE';
export type Timeframe = '1m' | '2m' | '5m';

export const TF_MS: Record<Timeframe, number> = { '1m': 60_000, '2m': 120_000, '5m': 300_000 };

export interface Candle { openTs: number; open: number; high: number; low: number; close: number; tickCount: number }
export interface Tick { ts: number; price: number }

export type FeedLabel = 'mean-reverting' | 'trending' | 'none';
export interface FeedStructure {
  label: FeedLabel; strength: number; autocorr: number[]; varianceRatio: number; runsZ: number; streakReversalRate: number;
}
/** Used until a feed-structure engine has enough candles to say anything. */
export const NEUTRAL_FEED: FeedStructure = {
  label: 'none', strength: 0, autocorr: [0, 0, 0, 0, 0], varianceRatio: 1, runsZ: 0, streakReversalRate: 0.5,
};

export interface SessionInfo { hourUtc: number; dayOfWeek: number; isOTC: boolean; marketOpen: boolean }

export interface Context {
  asset: string; isOTC: boolean; tf: Timeframe;
  candles: Candle[];            // closed candles, oldest first
  forming: Candle | null;       // the candle in progress
  ticks: Tick[];                // ticks of the forming candle
  now: number;                  // server time
  candleCloseAt: number;        // server time of the next close (= openTs of the candle being predicted)
  feed: FeedStructure;
  payout: number;               // fraction, 0.85 for 85%
  session: SessionInfo;
}

export interface Vote {
  engine: string; direction: Direction;
  confidence: number;           // 0.5..1.0; 0.5 means no opinion
  reasons: string[];            // human-readable, shown in the panel
  features?: Record<string, number>;
}

export interface EngineStats {
  votes: number; abstains: number; hits: number; ties: number;
  last100: number | null; last200: number | null; brier: number | null; killed: boolean;
}

export type EngineKind = 'direction' | 'context' | 'gate' | 'baseline' | 'judge';

export interface Engine {
  id: string;
  kind: EngineKind;
  warmupCandles: number;        // ABSTAIN until this many closed candles exist
  vote(ctx: Context): Vote;     // pure: no side effects, no I/O
  /** Learning happens here. `ctx` is the Context the vote was made with, not the one at scoring time. */
  onOutcome(vote: Vote, outcome: Outcome, ctx: Context): void;
  stats(asset: string): EngineStats;
  serialize(): unknown;         // persisted to the ledger after every outcome
  restore(state: unknown): void;
}

/**
 * Context engines that describe the feed (engine 6). The pipeline calls structure() before any
 * direction engine votes and puts the result in Context.feed. The ctx it receives carries the
 * previous FeedStructure (or NEUTRAL_FEED). structure() is pure, like vote().
 */
export interface FeedStructureEngine extends Engine {
  kind: 'context';
  structure(ctx: Context): FeedStructure;
}

export function isFeedStructureEngine(e: Engine): e is FeedStructureEngine {
  return e.kind === 'context' && typeof (e as Partial<FeedStructureEngine>).structure === 'function';
}

/** Engines are built per run so that a seed fully determines the result. */
export type EngineFactory = (seed: number) => Engine;

// ---------------------------------------------------------------------------
// Market events: the boundary between the Quotex decoder (extension) and the pipeline (core)
// ---------------------------------------------------------------------------

export type MarketEvent =
  | { kind: 'tick'; asset: string; isOTC: boolean; ts: number; price: number }
  /** A closed candle as reported by the feed itself; used to reconcile rebuilt candles. */
  | { kind: 'candle'; asset: string; isOTC: boolean; tf: Timeframe; candle: Candle }
  | { kind: 'payout'; asset: string; isOTC: boolean; ts: number; percent: number }
  /** Server-time heartbeat so time advances (freeze, scoring) even when no ticks arrive. */
  | { kind: 'clock'; ts: number };

/** Anything that consumes market events in order. The core Pipeline implements this. */
export interface MarketEventSink {
  onEvent(ev: MarketEvent): Promise<void>;
}

// ---------------------------------------------------------------------------
// Ledger records (BB_Qx.md, "IndexedDB stores")
// ---------------------------------------------------------------------------

export function voteIdOf(asset: string, tf: Timeframe, candleOpenTs: number, engine: string): string {
  return `${asset}|${tf}|${candleOpenTs}|${engine}`;
}
export function signalIdOf(asset: string, tf: Timeframe, candleOpenTs: number): string {
  return `${asset}|${tf}|${candleOpenTs}`;
}

export interface VoteRecord {
  voteId: string;               // voteIdOf(asset, tf, candleOpenTs, engine)
  ts: number;                   // server time the vote was written
  asset: string; isOTC: boolean; tf: Timeframe;
  candleOpenTs: number;         // openTs of the candle being predicted
  bucket: number;               // session bucket: UTC hour (0..23) of candleOpenTs
  engine: string; direction: Direction; confidence: number;
  reasons: string[]; features?: Record<string, number>;
  payoutAtVote: number;         // fraction
  frozenAt: number;             // server time of the T-5s freeze
}

/** Only UP / DOWN votes are scored; ABSTAIN votes never get an outcome. */
export interface OutcomeRecord {
  voteId: string;
  result: Outcome;
  openPrice: number;            // open of the predicted candle
  closePrice: number;           // close of the predicted candle, as the feed reports it
  scoredAt: number;             // server time
}

export interface ShadowStake { flat: number; quarterKelly: number }

export interface SignalRecord {
  signalId: string;             // signalIdOf(asset, tf, candleOpenTs)
  ts: number;
  asset: string; isOTC: boolean; tf: Timeframe; candleOpenTs: number; bucket: number;
  p: number;                    // verifier p(UP)
  threshold: number;            // the bar max(p, 1-p) had to clear: p*(payout) + margin + gate raises
  direction: 'UP' | 'DOWN' | 'NO_TRADE';
  stakeShadow: ShadowStake | null;
  gateFlags: Record<string, number>;
  engineWeights: Record<string, number>;
}

export type EventKind =
  | 'drift_alarm' | 'kill' | 'unkill' | 'pattern_validated' | 'pattern_expired' | 'reload'
  | 'feed_gap' | 'candle_mismatch' | 'asset_paused' | 'recorder' | 'info';

export interface EventRecord {
  seq: number;                  // assigned by the ledger, strictly increasing
  ts: number;
  kind: EventKind;
  asset?: string;
  engine?: string;
  payload: Record<string, unknown>;
}

export interface CandleRecord extends Candle {
  asset: string; isOTC: boolean; tf: Timeframe;
  source: 'feed' | 'rebuilt';
}

export interface TickRecord { asset: string; ts: number; price: number }
export interface PayoutRecord { asset: string; ts: number; percent: number }

/** Raw WebSocket frames captured for schema mapping (phase 0). Extension only; never replayed into decisions. */
export interface RawFrameRecord {
  seq: number;                  // assigned by the ledger
  receivedAt: number;           // LOCAL time the frame was seen
  tabId: number;
  socketUrl: string;
  dir: 'in' | 'out';
  encoding: 'text' | 'base64';
  data: string;
}

export interface FeedStructureRecord extends FeedStructure { asset: string; ts: number }

export type PatternStatus = 'candidate' | 'validated' | 'expired';
export interface PatternRecord {
  asset: string; key: string; status: PatternStatus;
  occurrences: number; winsA: number; winsB: number; days: number;
  firstSeen: number; lastSeen: number; validatedAt: number | null; expiredAt: number | null;
}

export interface EngineStatsRecord extends EngineStats { engine: string; asset: string; bucket: number | 'all' }

export interface EngineStateRecord { engine: string; ts: number; state: unknown }

// ---------------------------------------------------------------------------
// Ledger API (BB_Qx.md, "Agent split" > Contracts)
// Two implementations, behaviourally identical: in-memory (src/ledger/memory.ts, harness) and
// IndexedDB (src/ledger/indexeddb.ts, extension). src/ledger/conformance.ts holds the shared test suite.
// ---------------------------------------------------------------------------

export class LedgerConflictError extends Error {
  constructor(store: string, key: string) {
    super(`ledger: ${store} already has ${key}; votes, outcomes, signals and events are append-only`);
    this.name = 'LedgerConflictError';
  }
}

export interface VoteQuery {
  engine?: string; asset?: string; isOTC?: boolean; tf?: Timeframe; bucket?: number;
  fromTs?: number; toTs?: number;   // on candleOpenTs: fromTs inclusive, toTs exclusive
  scoredOnly?: boolean;             // only votes that have an outcome
  lastN?: number;                   // keep only the most recent N after the other filters
}

export interface ScoredVote { vote: VoteRecord; outcome: OutcomeRecord | null }

export interface TimeRange { fromTs?: number; toTs?: number }   // fromTs inclusive, toTs exclusive

export interface LedgerExport {
  format: 'bbqx-ledger';
  version: 1;
  votes: VoteRecord[];              // each array sorted by its store key, so exports compare byte for byte
  outcomes: OutcomeRecord[];
  signals: SignalRecord[];
  events: EventRecord[];
  candles: CandleRecord[];
  payouts: PayoutRecord[];
  feedStructure: FeedStructureRecord[];
  patterns: PatternRecord[];
  engineStats: EngineStatsRecord[];
  ticks?: TickRecord[];             // only with { includeTicks: true }
}

export interface Ledger {
  // Append-only. Writing an existing key throws LedgerConflictError.
  appendVote(v: VoteRecord): Promise<void>;
  appendOutcome(o: OutcomeRecord): Promise<void>;
  appendSignal(s: SignalRecord): Promise<void>;
  appendEvent(e: Omit<EventRecord, 'seq'>): Promise<number>;
  appendRawFrames(frames: Omit<RawFrameRecord, 'seq'>[]): Promise<void>;

  // Idempotent writes. Ticks with an existing asset+ts are ignored. A 'feed' candle replaces a
  // 'rebuilt' one with the same key; a 'rebuilt' candle never replaces a 'feed' one.
  appendTicks(ticks: TickRecord[]): Promise<void>;
  putCandle(c: CandleRecord): Promise<void>;
  appendPayout(p: PayoutRecord): Promise<void>;
  putFeedStructure(r: FeedStructureRecord): Promise<void>;
  putPattern(r: PatternRecord): Promise<void>;
  putEngineStats(r: EngineStatsRecord): Promise<void>;
  putEngineState(r: EngineStateRecord): Promise<void>;

  // Reads. Every list is oldest first.
  queryVotes(q: VoteQuery): Promise<ScoredVote[]>;
  getOutcome(voteId: string): Promise<OutcomeRecord | null>;
  getCandles(asset: string, tf: Timeframe, range?: TimeRange): Promise<CandleRecord[]>;
  getTicks(asset: string, range?: TimeRange): Promise<TickRecord[]>;
  latestPayout(asset: string, atOrBeforeTs: number): Promise<PayoutRecord | null>;
  listSignals(q: { asset?: string } & TimeRange): Promise<SignalRecord[]>;
  listEvents(q: { kind?: EventKind; asset?: string } & TimeRange): Promise<EventRecord[]>;
  listPatterns(asset: string): Promise<PatternRecord[]>;
  getEngineStats(engine: string, asset: string, bucket: number | 'all'): Promise<EngineStatsRecord | null>;
  getEngineState(engine: string): Promise<EngineStateRecord | null>;
  listRawFrames(q: { tabId?: number; fromSeq?: number; limit?: number }): Promise<RawFrameRecord[]>;
  /** Counts per `${asset}|${tf}`, for the panel. */
  countCandles(): Promise<Record<string, number>>;
  listAssets(): Promise<{ asset: string; isOTC: boolean }[]>;

  /** Applies retention from BB_Qx.md: ticks 2 h per asset, candles 30 d then thinned to 5m, payouts and feed_structure 30 d. Votes, outcomes, signals, patterns, events are never deleted. */
  prune(nowTs: number): Promise<void>;
  export(opts?: { includeTicks?: boolean }): Promise<LedgerExport>;
}

// ---------------------------------------------------------------------------
// Harness contract (BB_Qx.md, "Agent split" > Contracts): run(source, engines, seed) -> ledger.
// Identical inputs produce an identical ledger: JSON.stringify(await ledger.export()) matches byte for byte.
// ---------------------------------------------------------------------------

export interface SourceAsset { asset: string; isOTC: boolean; payoutPercent: number }

export interface DataSource {
  id: string;                   // e.g. 'synthetic:bounded:k=0.08' or 'recorded:2026-10-23'
  assets: SourceAsset[];
  /** Ordered by ts. Deterministic for a given seed (recorded sources ignore the seed). */
  events(seed: number): Iterable<MarketEvent>;
}

export interface RunOptions {
  tf?: Timeframe;               // default '1m'
  freezeBeforeCloseMs?: number; // default 5000
  confirmDelayMs?: number;      // default 2000
}

export type HarnessRun = (source: DataSource, engines: EngineFactory[], seed: number, opts?: RunOptions) => Promise<Ledger>;

// ---------------------------------------------------------------------------
// Recorded dataset file: what the extension exports and the harness replays.
// NDJSON. Line 1 is a DatasetMeta; every following line is one MarketEvent, ordered by ts.
// ---------------------------------------------------------------------------

export interface DatasetMeta {
  format: 'bbqx-dataset';
  version: 1;
  createdAt: number;
  assets: SourceAsset[];
  note?: string;
}

// ---------------------------------------------------------------------------
// Shared maths
// ---------------------------------------------------------------------------

/** Break-even probability for a payout fraction: p* = 1 / (1 + payout). */
export function breakEven(payout: number): number {
  return 1 / (1 + payout);
}

/** Session bucket of a server timestamp: its UTC hour. */
export function bucketOf(ts: number): number {
  return new Date(ts).getUTCHours();
}
