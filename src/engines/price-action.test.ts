import { describe, expect, it } from 'vitest';
import { NEUTRAL_FEED, type Candle, type Context, type FeedStructure } from '../core/contracts';
import { contextAt } from './__fixtures__/context';
import { FIXTURE_T0 } from './__fixtures__/generator';
import { createPriceActionEngine, DEFAULT_PRICE_ACTION, priceActionFactory, priceActionWarmup } from './price-action';

const MIN = 60_000;
const MR: FeedStructure = { label: 'mean-reverting', strength: 0.5, autocorr: [-0.1, -0.05, 0, 0, 0], varianceRatio: 0.6, runsZ: 2, streakReversalRate: 0.56 };
const TR: FeedStructure = { label: 'trending', strength: 1, autocorr: [0, 0, 0, 0, 0], varianceRatio: 1, runsZ: 0, streakReversalRate: 0.5 };

/** 1m candles from closes; open = previous close, wicks 0.001 outside the body. */
function fromCloses(cs: number[]): Candle[] {
  return cs.map((close, i) => {
    const open = i === 0 ? close : cs[i - 1]!;
    return { openTs: FIXTURE_T0 + i * MIN, open, high: Math.max(open, close) + 0.001, low: Math.min(open, close) - 0.001, close, tickCount: 60 };
  });
}
/** 100.00 / 100.05 alternating: no streaks, %B away from the extremes, RSI near 50. */
const alternating = (n: number): number[] => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 100.05 : 100));
const last = (cs: Candle[], feed: FeedStructure): Context => contextAt(cs, cs.length - 1, feed);

describe('price action engine', () => {
  const engine = createPriceActionEngine();

  it('identity and warmup sized to the 15m regime', () => {
    const e = priceActionFactory(3);
    expect([e.id, e.kind, e.warmupCandles]).toEqual(['price-action', 'direction', 149]); // 15 * (8 + 1) + 14
    expect(priceActionWarmup(DEFAULT_PRICE_ACTION, '5m')).toBe(29);
    expect(priceActionWarmup(DEFAULT_PRICE_ACTION, '2m')).toBe(24); // no 15m regime on 2m candles
  });

  it('abstains while warming up', () => {
    const v = engine.vote(last(fromCloses(alternating(148)), MR));
    expect(v.direction).toBe('ABSTAIN');
    expect(v.reasons[0]).toBe('warming up: 148/149 closed candles');
  });

  it('abstains when the feed has no structure, but still reports features', () => {
    const cs = fromCloses([...alternating(200), 101]);
    const v = engine.vote(last(cs, NEUTRAL_FEED));
    expect(v.direction).toBe('ABSTAIN');
    expect(v.reasons[0]).toMatch(/^no structure/);
    expect(v.features!['percentB']).toBeGreaterThan(1);
  });

  it('band-fade (with rsi-fade agreeing) in a mean-reverting feed; reasons carry the numbers', () => {
    const v = engine.vote(last(fromCloses([...alternating(200), 101]), MR));
    expect(v.direction).toBe('DOWN');
    expect(v.confidence).toBeCloseTo(0.52 + 0.06 * 0.5, 12);
    expect(v.reasons[0]).toBe('DOWN via band-fade + rsi-fade (feed mean-reverting, strength 0.50)');
    expect(v.reasons[1]).toMatch(/^band-fade: close above upper band, %B \d+\.\d\d > 1\.00$/);
    expect(v.reasons[2]).toMatch(/^rsi-fade: RSI \d+\.\d >= 70$/);
    expect(v.features).toMatchObject({ 'rule:band-fade': -1, 'rule:rsi-fade': -1, 'rule:streak-fade': 0, feedMeanReverting: 1 });
  });

  it('streak-fade alone after four green candles', () => {
    const v = engine.vote(last(fromCloses([...alternating(200), 100.005, 100.01, 100.015, 100.02]), MR));
    expect(v.direction).toBe('DOWN');
    expect(v.reasons).toEqual(['DOWN via streak-fade (feed mean-reverting, strength 0.50)', 'streak-fade: 4 green candles in a row (>= 4)']);
  });

  it('wick-rejection: a long lower wick that pierced the lower band', () => {
    const cs = fromCloses(alternating(200));
    const prev = cs[cs.length - 1]!.close; // 100
    cs.push({ openTs: cs[cs.length - 1]!.openTs + MIN, open: prev, close: prev + 0.01, high: prev + 0.011, low: prev - 0.2, tickCount: 60 });
    const v = engine.vote(last(cs, MR));
    expect(v.direction).toBe('UP');
    expect(v.reasons[0]).toContain('wick-rejection');
    expect(v.reasons[1]).toMatch(/^wick-rejection: lower wick 10\.00x body/);
  });

  it('abstains when rules disagree', () => {
    // a long slide drives RSI near 0 (fade: UP), then four tiny green candles (fade: DOWN)
    const slide = Array.from({ length: 60 }, (_, i) => 100 - 0.1 * (i + 1));
    const end = slide[slide.length - 1]!;
    const v = engine.vote(last(fromCloses([...alternating(100), ...slide, end + 0.001, end + 0.002, end + 0.003, end + 0.004]), MR));
    expect(v.direction).toBe('ABSTAIN');
    expect(v.reasons[0]).toMatch(/^rules disagree: .*streak-fade DOWN.*rsi-fade UP/);
  });

  it('trend-follow in a trending feed when the 5m and 15m regimes and the EMAs agree', () => {
    const up = Array.from({ length: 240 }, (_, i) => 100 + 0.01 * i + (i % 2 ? 0.003 : 0));
    const v = engine.vote(last(fromCloses(up), TR));
    expect(v.direction).toBe('UP');
    expect(v.confidence).toBeCloseTo(0.58, 12);
    expect(v.reasons[1]).toMatch(/^trend-follow: 5m ER \d\.\d\d and 15m ER \d\.\d\d both up/);
    const down = Array.from({ length: 240 }, (_, i) => 100 - 0.01 * i + (i % 2 ? 0.003 : 0));
    expect(engine.vote(last(fromCloses(down), TR)).direction).toBe('DOWN');
  });

  it('a trending label on a ranging series fires nothing; mean-reversion rules are off in a trending feed', () => {
    const v = engine.vote(last(fromCloses([...alternating(200), 101]), TR));
    expect(v.direction).toBe('ABSTAIN');
    expect(v.reasons[0]).toMatch(/^no rule fired/);
  });

  it('confidence follows feed strength; weak labels can be ignored', () => {
    const cs = fromCloses([...alternating(200), 101]);
    expect(engine.vote(last(cs, { ...MR, strength: 0 })).confidence).toBeCloseTo(0.52, 12);
    expect(engine.vote(last(cs, { ...MR, strength: 1 })).confidence).toBeCloseTo(0.58, 12);
    expect(createPriceActionEngine({ minFeedStrength: 0.6 }).vote(last(cs, MR)).direction).toBe('ABSTAIN');
  });

  it('is pure and ignores the forming candle', () => {
    const cs = fromCloses([...alternating(200), 101]);
    const ctx = last(cs, MR);
    ctx.candles.forEach((c) => Object.freeze(c));
    Object.freeze(ctx.candles);
    const a = engine.vote(ctx);
    expect(engine.vote(ctx)).toEqual(a);
    const forming: Candle = { openTs: ctx.candles[ctx.candles.length - 1]!.openTs + MIN, open: 101, high: 120, low: 80, close: 85, tickCount: 3 };
    expect(engine.vote({ ...ctx, forming, ticks: [{ ts: forming.openTs + 1000, price: 85 }] })).toEqual(a);
    expect(engine.stats(ctx.asset).votes).toBe(0); // voting never touches statistics
  });

  it('tracks per-asset statistics in onOutcome and round-trips them', () => {
    const e = createPriceActionEngine();
    const ctx = last(fromCloses([...alternating(200), 101]), MR);
    const vote = e.vote(ctx);
    e.onOutcome(vote, 'WIN', ctx);
    e.onOutcome(vote, 'TIE', ctx);
    e.onOutcome(vote, 'LOSS', { ...ctx, asset: 'OTHER' });
    expect(e.stats(ctx.asset)).toMatchObject({ votes: 2, hits: 1, ties: 1, last100: null, killed: false });
    expect(e.stats(ctx.asset).brier).toBeCloseTo((vote.confidence - 1) ** 2, 12);
    const f = createPriceActionEngine();
    f.restore(JSON.parse(JSON.stringify(e.serialize())));
    expect(f.stats(ctx.asset)).toEqual(e.stats(ctx.asset));
    expect(f.stats('OTHER')).toEqual(e.stats('OTHER'));
  });
});
