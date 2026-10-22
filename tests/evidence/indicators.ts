// Reference indicator implementations for the evidence tests. Written here on purpose: QA does not
// read the engines agent's feature library before testing it. Each returns one value per candle
// (NaN until the window is full).

import type { Candle } from '../../src/core/contracts';

export function ema(xs: readonly number[], period: number): number[] {
  const a = 2 / (period + 1);
  const out: number[] = [];
  let e = NaN;
  for (let i = 0; i < xs.length; i++) {
    if (i === period - 1) {
      let s = 0;
      for (let j = 0; j < period; j++) s += xs[j]!;
      e = s / period; // seeded with the SMA of the first window
    } else if (i >= period) {
      e = a * xs[i]! + (1 - a) * e;
    }
    out.push(i >= period - 1 ? e : NaN);
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(closes: readonly number[], period = 14): number[] {
  const out: number[] = [NaN];
  let gain = 0, loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= period) {
      gain += g / period;
      loss += l / period;
    } else {
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
    }
    out.push(i < period ? NaN : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  }
  return out;
}

function window(cs: readonly Candle[], i: number, period: number): { hh: number; ll: number } {
  let hh = -Infinity, ll = Infinity;
  for (let j = i - period + 1; j <= i; j++) {
    hh = Math.max(hh, cs[j]!.high);
    ll = Math.min(ll, cs[j]!.low);
  }
  return { hh, ll };
}

/** Fast stochastic %K. */
export function stochK(cs: readonly Candle[], period = 14): number[] {
  return cs.map((c, i) => {
    if (i < period - 1) return NaN;
    const { hh, ll } = window(cs, i, period);
    return hh === ll ? 50 : (100 * (c.close - ll)) / (hh - ll);
  });
}

export function williamsR(cs: readonly Candle[], period = 14): number[] {
  return cs.map((c, i) => {
    if (i < period - 1) return NaN;
    const { hh, ll } = window(cs, i, period);
    return hh === ll ? -50 : (-100 * (hh - c.close)) / (hh - ll);
  });
}

export function cci(cs: readonly Candle[], period = 20): number[] {
  const tp = cs.map((c) => (c.high + c.low + c.close) / 3);
  return tp.map((x, i) => {
    if (i < period - 1) return NaN;
    let mean = 0;
    for (let j = i - period + 1; j <= i; j++) mean += tp[j]!;
    mean /= period;
    let dev = 0;
    for (let j = i - period + 1; j <= i; j++) dev += Math.abs(tp[j]! - mean);
    dev /= period;
    return dev === 0 ? 0 : (x - mean) / (0.015 * dev);
  });
}

/** EMA(fast) - EMA(slow) of closes: EMA 9-21 spread, or the MACD line with 12/26. */
export function emaSpread(closes: readonly number[], fast: number, slow: number): number[] {
  const f = ema(closes, fast), s = ema(closes, slow);
  return f.map((x, i) => x - s[i]!);
}
