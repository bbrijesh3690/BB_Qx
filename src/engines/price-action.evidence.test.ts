// Evidence for price action on the fixture generator. Thresholds were tuned on seed 1; these runs
// use seeds 2, 3 and 4. Each decision sees closed candles up to t and is scored on candle t + 2
// (candle t + 1 is still forming at the T-5s freeze), exactly as the pipeline scores votes.
// Print the table with: npx vitest run src/engines/price-action.evidence.test.ts --silent=false

import { describe, expect, it } from 'vitest';
import type { FeedStructure, FeedStructureEngine } from '../core/contracts';
import { feedOptions, generateCandles, type FeedKind } from './__fixtures__/generator';
import { wilson } from './__fixtures__/label-rates';
import { accuracy, shadowRun, type ShadowResult, type Tally } from './__fixtures__/shadow-run';
import { createFeedStructureEngine } from './feed-structure';
import { createPriceActionEngine } from './price-action';

const REPORT_SEEDS = [2, 3, 4];
const N = 20_000;
const ALL: FeedKind[] = ['random', 'bounded-0.08', 'bounded-0.2', 'trending'];

function run(kind: FeedKind, seed: number): ShadowResult {
  const candles = generateCandles({ n: N, seed: seed * 7777 + ALL.indexOf(kind), ...feedOptions(kind) });
  return shadowRun(candles, createFeedStructureEngine(), createPriceActionEngine());
}

const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;
function line(name: string, t: Tally, decisions: number, z = 1.96): string {
  const n = t.votes - t.ties;
  const [lo, hi] = wilson(t.hits, n, z);
  return `${name.padEnd(26)} votes ${String(t.votes).padStart(5)} of ${decisions} (${pct(t.votes / decisions).padStart(5)})  accuracy ${pct(accuracy(t)).padStart(5)} n=${n} ${z === 1.96 ? '95' : '99'}% CI [${pct(lo)}, ${pct(hi)}]  ties ${t.ties}`;
}

function evidence(kind: FeedKind): { pooled: Tally; decisions: number; results: ShadowResult[] } {
  const results = REPORT_SEEDS.map((s) => run(kind, s));
  const pooled: Tally = { votes: 0, hits: 0, ties: 0 };
  let decisions = 0;
  const rules: Record<string, Tally> = {};
  const out: string[] = [];
  results.forEach((r, i) => {
    pooled.votes += r.overall.votes; pooled.hits += r.overall.hits; pooled.ties += r.overall.ties;
    decisions += r.decisions;
    for (const [k, t] of Object.entries(r.byRule)) {
      const acc = (rules[k] ??= { votes: 0, hits: 0, ties: 0 });
      acc.votes += t.votes; acc.hits += t.hits; acc.ties += t.ties;
    }
    const f = r.feedLabels;
    out.push(`${line(`${kind} seed ${REPORT_SEEDS[i]}`, r.overall, r.decisions)}  feed MR/trend/none ${f.meanReverting}/${f.trending}/${f.none}`);
  });
  out.push(line(`${kind} pooled`, pooled, decisions));
  if (kind === 'random') out.push(line(`${kind} pooled`, pooled, decisions, 2.576));
  for (const [k, t] of Object.entries(rules).sort()) out.push(`  rule ${line(k, t, decisions).trimStart()}`);
  console.log(out.join('\n'));
  return { pooled, decisions, results };
}

describe('price action evidence on fixture feeds (report seeds 2-4, 20,000 candles each)', () => {
  it('random walk: about 50% within its 99% CI, abstains on most candles', () => {
    const { pooled, decisions, results } = evidence('random');
    const [lo, hi] = wilson(pooled.hits, pooled.votes - pooled.ties, 2.576);
    expect(lo).toBeLessThanOrEqual(0.5);
    expect(hi).toBeGreaterThanOrEqual(0.5);
    for (const r of results) expect(r.abstains / r.decisions).toBeGreaterThanOrEqual(0.9);
    expect(pooled.votes / decisions).toBeLessThanOrEqual(0.05);
  });

  it('bounded k = 0.08: vote rate and accuracy with n and Wilson 95% CI', () => {
    const { pooled } = evidence('bounded-0.08');
    expect(wilson(pooled.hits, pooled.votes - pooled.ties)[0]).toBeGreaterThan(0.5);
  });

  it('bounded k = 0.2: vote rate and accuracy with n and Wilson 95% CI', () => {
    const { pooled } = evidence('bounded-0.2');
    expect(wilson(pooled.hits, pooled.votes - pooled.ties)[0]).toBeGreaterThan(0.5);
  });

  it('trending (drift 0.1 sigma, best possible 54.0%): vote rate and accuracy', () => {
    const { pooled } = evidence('trending');
    expect(wilson(pooled.hits, pooled.votes - pooled.ties)[0]).toBeGreaterThan(0.5);
  });

  // The feed engine rarely mislabels a random walk, so the check above has a small n. Forcing the
  // label shows what the rules themselves do on noise: if they leaked the future, this would show it.
  it.each(['mean-reverting', 'trending'] as const)('random walk with the label forced to %s: rules score one half within the 99 percent CI', (label) => {
    const forced: FeedStructure = { label, strength: 0.5, autocorr: [0, 0, 0, 0, 0], varianceRatio: 1, runsZ: 0, streakReversalRate: 0.5 };
    const feedEngine: FeedStructureEngine = { ...createFeedStructureEngine(), structure: () => forced };
    const pooled: Tally = { votes: 0, hits: 0, ties: 0 };
    let decisions = 0;
    for (const seed of REPORT_SEEDS) {
      const r = shadowRun(generateCandles({ n: N, seed: seed * 7777, ...feedOptions('random') }), feedEngine, createPriceActionEngine());
      pooled.votes += r.overall.votes; pooled.hits += r.overall.hits; pooled.ties += r.overall.ties;
      decisions += r.decisions;
    }
    console.log(line(`random, forced ${label}`, pooled, decisions, 2.576));
    const [lo, hi] = wilson(pooled.hits, pooled.votes - pooled.ties, 2.576);
    expect(pooled.votes).toBeGreaterThan(3000);
    expect(lo).toBeLessThanOrEqual(0.5);
    expect(hi).toBeGreaterThanOrEqual(0.5);
  });
});
