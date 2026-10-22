import { describe, expect, it } from 'vitest';
import { isFeedStructureEngine, NEUTRAL_FEED } from '../core/contracts';
import { contextAt } from './__fixtures__/context';
import { feedOptions, generateCandles, type FeedKind } from './__fixtures__/generator';
import { labelRates, type LabelRates } from './__fixtures__/label-rates';
import { createFeedStructureEngine, DEFAULT_FEED_STRUCTURE, feedStructureFactory, significanceStrength } from './feed-structure';

describe('feed-structure engine contract', () => {
  const candles = generateCandles({ n: 1500, seed: 42, ...feedOptions('bounded-0.2') });

  it('identity and kind', () => {
    const e = feedStructureFactory(7);
    expect(e.id).toBe('feed-structure');
    expect(e.kind).toBe('context');
    expect(e.warmupCandles).toBe(200);
    expect(isFeedStructureEngine(e)).toBe(true);
  });

  it('neutral until warm', () => {
    const e = createFeedStructureEngine();
    const ctx = contextAt(candles, 198); // 199 closed candles
    expect(e.structure(ctx)).toEqual(NEUTRAL_FEED);
    const v = e.vote(ctx);
    expect(v).toMatchObject({ engine: 'feed-structure', direction: 'ABSTAIN', confidence: 0.5 });
    expect(v.reasons[0]).toMatch(/warming up/);
  });

  it('votes ABSTAIN at 0.5 with the numbers in features and the label in reasons', () => {
    const e = createFeedStructureEngine();
    const ctx = contextAt(candles, 1400);
    const s = e.structure(ctx);
    const v = e.vote(ctx);
    expect(s.label).toBe('mean-reverting');
    expect(s.autocorr).toHaveLength(5);
    expect(v.direction).toBe('ABSTAIN');
    expect(v.confidence).toBe(0.5);
    expect(v.reasons[0]).toContain('mean-reverting');
    expect(v.features).toMatchObject({ n: 1000, labelMeanReverting: 1, labelTrending: 0, strength: s.strength, vr16: s.varianceRatio, runsZ: s.runsZ });
    for (const x of Object.values(v.features!)) expect(Number.isFinite(x)).toBe(true);
  });

  it('is pure and only looks at the last windowSize + 1 closed candles', () => {
    const e = createFeedStructureEngine();
    const ctx = contextAt(candles, 1400);
    Object.freeze(ctx.candles);
    const a = e.structure(ctx);
    expect(e.structure(ctx)).toEqual(a);
    expect(e.vote(ctx)).toEqual(e.vote(ctx));
    expect(e.structure(contextAt(candles, 1400, NEUTRAL_FEED, 'x', 1001))).toEqual(a);
    expect(e.structure({ ...ctx, feed: { ...a, label: 'trending' } })).toEqual(a); // ignores the previous FeedStructure
  });

  it('serialize / restore round-trips', () => {
    const e = createFeedStructureEngine();
    const ctx = contextAt(candles, 1400);
    e.onOutcome(e.vote(ctx), 'WIN', ctx);
    const f = createFeedStructureEngine();
    f.restore(JSON.parse(JSON.stringify(e.serialize())));
    expect(f.stats(ctx.asset)).toEqual(e.stats(ctx.asset));
    expect(f.serialize()).toEqual(e.serialize());
    expect(() => f.restore({ nonsense: true })).toThrow(TypeError);
  });

  it('strength reflects significance: 0 at the threshold, near 1 far beyond it', () => {
    expect(significanceStrength(2.1, 2.2)).toBe(0);
    expect(significanceStrength(2.2, 2.2)).toBeCloseTo(0, 12);
    expect(significanceStrength(3, 2.2)).toBeGreaterThan(0.9);
    expect(significanceStrength(2.5, 2.2)).toBeGreaterThan(0.4);
    expect(significanceStrength(2.5, 2.2)).toBeLessThan(0.6);
  });
});

// Thresholds were set on seed base 1 (scratch calibration); these runs use other seeds.
describe('feed-structure label rates over independent windows', () => {
  const kinds: FeedKind[] = ['random', 'bounded-0.08', 'bounded-0.2', 'trending'];
  const pct = (x: number): string => `${(100 * x).toFixed(1)}%`.padStart(6);
  const row = (name: string, w: number, r: LabelRates): string =>
    `${name.padEnd(22)} W=${String(w).padEnd(5)} n=${r.windows}  mean-reverting ${pct(r.meanReverting)}  trending ${pct(r.trending)}  none ${pct(r.none)}  mean strength ${r.meanStrength.toFixed(2)}`;

  it('W = 1000 (default): random walk false calls <= 5%; bounded feeds labelled mean-reverting; trending labelled trending', () => {
    const r = Object.fromEntries(kinds.map((k, i) => [k, labelRates(k, 1000, 101 + i)])) as Record<FeedKind, LabelRates>;
    const vol = labelRates('random', 1000, 111, {}, { volPersistence: 0.98, volOfVol: 0.1 });
    // Lag-1 autocorrelation alone, at its own 1% random-walk quantile, for comparison.
    const ac1Cut = [...r.random.ac1].sort((a, b) => a - b)[Math.floor(0.01 * r.random.ac1.length)]!;
    const lag1Only = r['bounded-0.08'].ac1.filter((x) => x <= ac1Cut).length / r['bounded-0.08'].ac1.length;
    console.log([
      ...kinds.map((k) => row(k, 1000, r[k])),
      row('random + vol clustering', 1000, vol),
      `lag-1 autocorr alone at its 1% random-walk cut (${ac1Cut.toFixed(3)}): bounded-0.08 called in ${pct(lag1Only)} of windows`,
    ].join('\n'));

    expect(r.random.meanReverting + r.random.trending).toBeLessThanOrEqual(0.05);
    expect(vol.meanReverting + vol.trending).toBeLessThanOrEqual(0.05);
    expect(r['bounded-0.2'].meanReverting).toBeGreaterThanOrEqual(0.97);
    expect(r['bounded-0.08'].meanReverting).toBeGreaterThanOrEqual(0.8);
    expect(r['bounded-0.08'].trending + r['bounded-0.2'].trending).toBeLessThanOrEqual(0.01);
    expect(r.trending.trending).toBeGreaterThanOrEqual(0.5);
    expect(r.trending.meanReverting).toBeLessThanOrEqual(0.03);
  });

  it('W = 200 (just warm): conservative, random walk false calls <= 5%', () => {
    const r = Object.fromEntries(kinds.map((k, i) => [k, labelRates(k, 1000, 201 + i, { windowSize: 200 })])) as Record<FeedKind, LabelRates>;
    console.log(kinds.map((k) => row(k, 200, r[k])).join('\n'));
    expect(r.random.meanReverting + r.random.trending).toBeLessThanOrEqual(0.05);
    expect(r['bounded-0.2'].meanReverting).toBeGreaterThanOrEqual(0.3);
  });

  it('W = 2000 (option): what a longer window buys', () => {
    const r = Object.fromEntries(kinds.map((k, i) => [k, labelRates(k, 400, 301 + i, { windowSize: 2000 })])) as Record<FeedKind, LabelRates>;
    console.log(kinds.map((k) => row(k, 2000, r[k])).join('\n'));
    expect(r.random.meanReverting + r.random.trending).toBeLessThanOrEqual(0.05);
    expect(r['bounded-0.08'].meanReverting).toBeGreaterThanOrEqual(0.95);
    expect(r.trending.trending).toBeGreaterThanOrEqual(0.8);
  });

  it('defaults are the calibrated ones', () => {
    expect(DEFAULT_FEED_STRUCTURE).toMatchObject({ windowSize: 1000, warmup: 200, primaryQ: 16, mrVrZ: 2.2, momVrZ: 3.0, runsZ: 2.8, driftZ: 2.8 });
  });
});
