import { describe, expect, it } from 'vitest';
import type { Candle } from '../core/contracts';
import {
  aggregate, atr, bollinger, candleShape, colourOf, efficiencyRatio, ema, emaSeries, emaTrend, rsi, sma, stdev, streak,
  trueRange, WICK_RATIO_CAP,
} from './index';

const T0 = Date.UTC(2026, 0, 5);
const MIN = 60_000;

function c(open: number, high: number, low: number, close: number, i = 0): Candle {
  return { openTs: T0 + i * MIN, open, high, low, close, tickCount: 1 };
}
/** Candles whose only meaningful field is the close (open = previous close). */
function fromCloses(cs: number[]): Candle[] {
  return cs.map((x, i) => {
    const o = i === 0 ? x : cs[i - 1]!;
    return c(o, Math.max(o, x), Math.min(o, x), x, i);
  });
}

describe('series', () => {
  it('sma of the last period values', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toBe(4);
    expect(sma([1, 2], 3)).toBeNull();
    expect(() => sma([1], 0)).toThrow(RangeError);
  });

  it('ema seeded with the SMA, alpha = 2 / (period + 1)', () => {
    // alpha 0.5: seed (1+2+3)/3 = 2, then 0.5*4 + 0.5*2 = 3, then 0.5*5 + 0.5*3 = 4
    expect(emaSeries([1, 2, 3, 4, 5], 3)).toEqual([2, 3, 4]);
    expect(ema([1, 2, 3, 4, 5], 3)).toBe(4);
    expect(ema([1, 2], 3)).toBeNull();
  });

  it('population stdev of the last period values', () => {
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9], 8)).toBe(2);
    expect(stdev([100, 2, 4, 4, 4, 5, 5, 7, 9], 8)).toBe(2);
    expect(stdev([3, 3, 3], 3)).toBe(0);
  });
});

describe('atr (Wilder)', () => {
  const cs = [
    c(9, 10, 8, 9, 0),
    c(9, 11, 9, 10, 1),       // TR max(2, 2, 0) = 2
    c(10, 12, 9.5, 11, 2),    // TR max(2.5, 2, 0.5) = 2.5
    c(11, 11.5, 10.5, 11, 3), // TR max(1, 0.5, 0.5) = 1
    c(12, 13, 11.5, 12.5, 4), // gap: TR max(1.5, 2, 0.5) = 2
  ];

  it('true range uses the previous close', () => {
    expect(trueRange(cs[4]!, 11)).toBe(2);
  });

  it('seeds with the mean true range, then smooths', () => {
    expect(atr(cs.slice(0, 4), 3)).toBeCloseTo((2 + 2.5 + 1) / 3, 12);
    expect(atr(cs, 3)).toBeCloseTo((((2 + 2.5 + 1) / 3) * 2 + 2) / 3, 12); // 1.888...
    expect(atr(cs.slice(0, 3), 3)).toBeNull();
  });
});

describe('rsi (Wilder)', () => {
  const cs = fromCloses([10, 11, 10.5, 11.5, 12, 11]); // changes +1, -0.5, +1, +0.5, -1

  it('first value from plain means: gains 2/3, losses 0.5/3, RS 4', () => {
    expect(rsi(cs.slice(0, 4), 3)).toBeCloseTo(80, 10);
  });
  it('then Wilder smoothing: gains 0.6111, losses 0.1111, RS 5.5', () => {
    expect(rsi(cs.slice(0, 5), 3)).toBeCloseTo(100 - 100 / 6.5, 10);
  });
  it('equal smoothed gains and losses give 50', () => {
    expect(rsi(cs, 3)).toBeCloseTo(50, 10);
  });
  it('edge cases', () => {
    expect(rsi(fromCloses([1, 2, 3, 4]), 3)).toBe(100);
    expect(rsi(fromCloses([5, 5, 5, 5]), 3)).toBe(50);
    expect(rsi(fromCloses([1, 2, 3]), 3)).toBeNull();
  });
});

describe('bollinger %B', () => {
  it('position of the close between mean -/+ 2 population sd', () => {
    // last 4 closes 5, 5, 7, 9: mean 6.5, variance 11/4
    const b = bollinger(fromCloses([2, 4, 4, 4, 5, 5, 7, 9]), 4, 2)!;
    const sd = Math.sqrt(2.75);
    expect(b.middle).toBe(6.5);
    expect(b.upper).toBeCloseTo(6.5 + 2 * sd, 12);
    expect(b.lower).toBeCloseTo(6.5 - 2 * sd, 12);
    expect(b.percentB).toBeCloseTo((9 - (6.5 - 2 * sd)) / (4 * sd), 12); // 0.8769
  });
  it('flat series gives 0.5; too short gives null', () => {
    expect(bollinger(fromCloses([3, 3, 3, 3]), 4)!.percentB).toBe(0.5);
    expect(bollinger(fromCloses([3, 3, 3]), 4)).toBeNull();
  });
});

describe('ema trend', () => {
  // Linear ramp close = t, every true range 2, so ATR = 2. An SMA-seeded EMA of a ramp lags it by
  // exactly (n - 1) / 2: EMA9 = t - 4, EMA21 = t - 10, spread 6 / 2 = 3, both slopes 1 / 2.
  const ramp = Array.from({ length: 40 }, (_, t) => c(t - 1, t + 0.5, t - 1.5, t, t));

  it('spread and slopes in ATR units', () => {
    const e = emaTrend(ramp)!;
    expect(e.atr).toBeCloseTo(2, 12);
    expect(e.spread).toBeCloseTo(3, 10);
    expect(e.fastSlope).toBeCloseTo(0.5, 10);
    expect(e.slowSlope).toBeCloseTo(0.5, 10);
  });
  it('null until the slow EMA has slopeLag + 1 values', () => {
    expect(emaTrend(ramp.slice(0, 23))).toBeNull();
    expect(emaTrend(ramp.slice(0, 24))).not.toBeNull();
  });
});

describe('candle shape', () => {
  it('wick-to-body ratios and fractions of the range', () => {
    const s = candleShape(c(10, 12, 9.5, 11)); // body 1, upper 1, lower 0.5, range 2.5
    expect(s.upperToBody).toBe(1);
    expect(s.lowerToBody).toBe(0.5);
    expect(s.bodyFrac).toBeCloseTo(0.4, 12);
    expect(s.upperFrac).toBeCloseTo(0.4, 12);
    expect(s.lowerFrac).toBeCloseTo(0.2, 12);
  });
  it('red candle: wicks measured from the body edges', () => {
    const s = candleShape(c(11, 11.2, 8, 10)); // body 1, upper 0.2, lower 2
    expect(s.upperToBody).toBeCloseTo(0.2, 12);
    expect(s.lowerToBody).toBe(2);
  });
  it('doji ratios are capped, flat candle is all zeros', () => {
    const d = candleShape(c(10, 11, 9, 10));
    expect(d.upperToBody).toBe(WICK_RATIO_CAP);
    expect(d.lowerToBody).toBe(WICK_RATIO_CAP);
    const f = candleShape(c(10, 10, 10, 10));
    expect([f.bodyFrac, f.upperFrac, f.upperToBody, f.lowerToBody]).toEqual([0, 0, 0, 0]);
  });
  it('colour', () => {
    expect([colourOf(c(1, 2, 1, 2)), colourOf(c(2, 2, 1, 1)), colourOf(c(1, 2, 0, 1))]).toEqual([1, -1, 0]);
  });
});

describe('efficiency ratio', () => {
  it('net move over path length', () => {
    expect(efficiencyRatio([1, 2, 1, 2, 3], 4)).toEqual({ er: 0.5, dir: 1 });
    expect(efficiencyRatio([5, 4, 3], 2)).toEqual({ er: 1, dir: -1 });
    expect(efficiencyRatio([1, 2, 1], 2)).toEqual({ er: 0, dir: 0 });
    expect(efficiencyRatio([2, 2, 2], 2)).toEqual({ er: 0, dir: 0 });
    expect(efficiencyRatio([1, 2], 2)).toBeNull();
  });
});

describe('streak', () => {
  it('length and colour of the trailing run', () => {
    expect(streak(fromCloses([1, 2, 1, 2, 3, 4]))).toEqual({ colour: 1, length: 3 });
    expect(streak(fromCloses([5, 4, 3]))).toEqual({ colour: -1, length: 2 });
    expect(streak(fromCloses([1, 2, 2]))).toEqual({ colour: 0, length: 0 });
    expect(streak([])).toEqual({ colour: 0, length: 0 });
  });
  it('a flat candle ends a streak; the first candle (open = close) counts as flat', () => {
    expect(streak(fromCloses([1, 1, 2, 3]))).toEqual({ colour: 1, length: 2 });
    expect(streak(fromCloses([1, 2, 3]))).toEqual({ colour: 1, length: 2 });
  });
});

describe('aggregate 1m into 5m / 15m', () => {
  // 1m candles 00:03 .. 00:21 with open = 100 + i, close = 100.5 + i, high close + 1, low open - 1
  const oneMin = (from: number, to: number): Candle[] => {
    const out: Candle[] = [];
    for (let m = from; m <= to; m++) out.push({ openTs: T0 + m * MIN, open: 100 + m, high: 101.5 + m, low: 99 + m, close: 100.5 + m, tickCount: 10 });
    return out;
  };

  it('keeps only complete buckets on server-time boundaries', () => {
    const agg = aggregate(oneMin(3, 21), MIN, 5 * MIN);
    expect(agg.map((x) => (x.openTs - T0) / MIN)).toEqual([5, 10, 15]); // 00:00 and 00:20 are partial
    expect(agg[0]).toEqual({ openTs: T0 + 5 * MIN, open: 105, high: 110.5, low: 104, close: 109.5, tickCount: 50 });
  });

  it('drops a bucket with a missing minute', () => {
    const cs = oneMin(0, 14).filter((x) => x.openTs !== T0 + 12 * MIN);
    expect(aggregate(cs, MIN, 5 * MIN).map((x) => (x.openTs - T0) / MIN)).toEqual([0, 5]);
  });

  it('15m buckets', () => {
    const agg = aggregate(oneMin(0, 44), MIN, 15 * MIN);
    expect(agg.map((x) => (x.openTs - T0) / MIN)).toEqual([0, 15, 30]);
    expect(agg[1]).toMatchObject({ open: 115, close: 129.5, high: 130.5, low: 114, tickCount: 150 });
    expect(aggregate(oneMin(0, 43), MIN, 15 * MIN)).toHaveLength(2);
  });

  it('rejects a target that is not a multiple of the base', () => {
    expect(() => aggregate([], 2 * MIN, 5 * MIN)).toThrow(RangeError);
  });
});
