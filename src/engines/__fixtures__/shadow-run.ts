// A minimal stand-in for the pipeline, for engine tests only: feed-structure first, its result into
// ctx.feed, then the direction engine votes on the candle after the forming one, and the vote is
// scored on that candle's colour. ABSTAIN votes get no outcome, as in the ledger contract.

import { NEUTRAL_FEED, type Candle, type Engine, type FeedStructure, type FeedStructureEngine, type Outcome, type Vote } from '../../core/contracts';
import { contextAt } from './context';

export interface Tally { votes: number; hits: number; ties: number }
export interface ShadowResult {
  candles: number;
  /** Decision points scored (every closed candle from 0 to n - 3). */
  decisions: number;
  abstains: number;
  /** UP / DOWN votes; ties are counted in `ties` and excluded from accuracy. */
  overall: Tally;
  /** Every rule's own call, whether or not the engine voted, read from features `rule:<name>`. */
  byRule: Record<string, Tally>;
  feedLabels: { meanReverting: number; trending: number; none: number };
  /** The last vote and its context, for spot checks. */
  lastVote: Vote | null;
}

export function outcomeOf(target: Candle, direction: 'UP' | 'DOWN'): Outcome {
  if (target.close === target.open) return 'TIE';
  return (target.close > target.open) === (direction === 'UP') ? 'WIN' : 'LOSS';
}

function add(t: Tally, o: Outcome): void {
  t.votes++;
  if (o === 'TIE') t.ties++;
  else if (o === 'WIN') t.hits++;
}

export function shadowRun(candles: readonly Candle[], feedEngine: FeedStructureEngine, engine: Engine, maxHistory = 1200, asset = 'FIXTURE_otc'): ShadowResult {
  const res: ShadowResult = {
    candles: candles.length, decisions: 0, abstains: 0, overall: { votes: 0, hits: 0, ties: 0 }, byRule: {},
    feedLabels: { meanReverting: 0, trending: 0, none: 0 }, lastVote: null,
  };
  let feed: FeedStructure = NEUTRAL_FEED;
  for (let t = 0; t + 2 < candles.length; t++) {
    const pre = contextAt(candles, t, feed, asset, maxHistory);
    feed = feedEngine.structure(pre);
    const ctx = { ...pre, feed };
    const label = feed.label === 'mean-reverting' ? 'meanReverting' : feed.label === 'trending' ? 'trending' : 'none';
    res.feedLabels[label]++;
    const vote = engine.vote(ctx);
    const target = candles[t + 2]!;
    res.decisions++;
    for (const [k, v] of Object.entries(vote.features ?? {})) {
      if (!k.startsWith('rule:') || v === 0) continue;
      add((res.byRule[k.slice(5)] ??= { votes: 0, hits: 0, ties: 0 }), outcomeOf(target, v > 0 ? 'UP' : 'DOWN'));
    }
    if (vote.direction === 'ABSTAIN') { res.abstains++; continue; }
    const outcome = outcomeOf(target, vote.direction);
    add(res.overall, outcome);
    engine.onOutcome(vote, outcome, ctx);
    res.lastVote = vote;
  }
  return res;
}

export function accuracy(t: Tally): number {
  const n = t.votes - t.ties;
  return n > 0 ? t.hits / n : NaN;
}
