// Statistics behind the feed-structure engine. Pure functions over a window of closed candles.
// Close-to-close log returns drive autocorrelation, variance ratios and drift; candle colours
// (close vs open, which is what a vote is scored on) drive the runs test and the streak reversal rate.

import type { Candle } from '../core/contracts';

export interface FeedStats {
  /** Number of log returns used. */
  n: number;
  /** Sample autocorrelation of returns at lags 1..maxLag. */
  autocorr: number[];
  /** (sum of autocorr + maxLag / n) / sqrt(maxLag / n): approximately N(0, 1) on iid returns. */
  acSumZ: number;
  /** Lo-MacKinlay variance ratio VR(q) for each q in the requested set. */
  vr: number[];
  /** Heteroskedasticity-robust z*(q) for each VR(q); negative means mean-reverting. */
  vrZ: number[];
  /** Wald-Wolfowitz runs z on candle colours (flat candles dropped); positive means more alternation than chance. */
  runsZ: number;
  /** After a run of minStreak or more same-coloured candles, the share whose next candle has the opposite colour. */
  streakReversalRate: number;
  streakEvents: number;
  /** (rate - 0.5) / sqrt(0.25 / events), 0 without events. */
  streakZ: number;
  /** Mean return / (sd / sqrt(n)): the drift t statistic. */
  driftZ: number;
}

export function logReturns(candles: readonly Candle[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const r = Math.log(candles[i]!.close / candles[i - 1]!.close);
    out.push(Number.isFinite(r) ? r : 0);
  }
  return out;
}

function mean(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return xs.length > 0 ? s / xs.length : 0;
}

export function autocorrelations(r: readonly number[], maxLag: number): number[] {
  const m = mean(r);
  let den = 0;
  for (const x of r) den += (x - m) ** 2;
  const out: number[] = [];
  for (let k = 1; k <= maxLag; k++) {
    if (den === 0 || r.length <= k) { out.push(0); continue; }
    let num = 0;
    for (let t = k; t < r.length; t++) num += (r[t]! - m) * (r[t - k]! - m);
    out.push(num / den);
  }
  return out;
}

/**
 * Lo-MacKinlay (1988) variance ratio with overlapping q-period returns and the bias-corrected
 * divisor m = q (T - q + 1)(1 - q / T); z* is their heteroskedasticity-consistent statistic.
 */
export function varianceRatio(r: readonly number[], q: number): { vr: number; z: number } {
  const T = r.length;
  if (q < 2 || T <= q + 1) return { vr: 1, z: 0 };
  const mu = mean(r);
  const dev2 = r.map((x) => (x - mu) ** 2);
  let ss = 0;
  for (const d of dev2) ss += d;
  if (ss === 0) return { vr: 1, z: 0 };
  const varA = ss / (T - 1);
  // q-period sums via a running window
  let win = 0;
  for (let t = 0; t < q; t++) win += r[t]!;
  let ssc = (win - q * mu) ** 2;
  for (let t = q; t < T; t++) {
    win += r[t]! - r[t - q]!;
    ssc += (win - q * mu) ** 2;
  }
  const m = q * (T - q + 1) * (1 - q / T);
  const vr = ssc / m / varA;
  let theta = 0;
  for (let j = 1; j < q; j++) {
    let s = 0;
    for (let t = j; t < T; t++) s += dev2[t]! * dev2[t - j]!;
    const delta = (T * s) / (ss * ss);
    theta += ((2 * (q - j)) / q) ** 2 * delta;
  }
  return { vr, z: theta > 0 ? (vr - 1) * Math.sqrt(T / theta) : 0 };
}

function colour(c: Candle): number {
  return c.close > c.open ? 1 : c.close < c.open ? -1 : 0;
}

export function runsZ(colours: readonly number[]): number {
  let n1 = 0, n2 = 0, runs = 0, prev = 0;
  for (const s of colours) {
    if (s === 0) continue;
    if (s > 0) n1++; else n2++;
    if (s !== prev) runs++;
    prev = s;
  }
  const n = n1 + n2;
  if (n1 === 0 || n2 === 0 || n < 3) return 0;
  const e = (2 * n1 * n2) / n + 1;
  const v = (2 * n1 * n2 * (2 * n1 * n2 - n)) / (n * n * (n - 1));
  return v > 0 ? (runs - e) / Math.sqrt(v) : 0;
}

export function streakReversal(colours: readonly number[], minStreak: number): { rate: number; events: number; z: number } {
  let len = 0, sign = 0, events = 0, reversals = 0;
  for (let t = 0; t < colours.length; t++) {
    const s = colours[t]!;
    if (len >= minStreak && s !== 0) {
      events++;
      if (s !== sign) reversals++;
    }
    if (s === 0) { len = 0; sign = 0; }
    else if (s === sign) len++;
    else { sign = s; len = 1; }
  }
  if (events === 0) return { rate: 0.5, events: 0, z: 0 };
  const rate = reversals / events;
  return { rate, events, z: (rate - 0.5) / Math.sqrt(0.25 / events) };
}

export function driftZ(r: readonly number[]): number {
  const n = r.length;
  if (n < 2) return 0;
  const m = mean(r);
  let ss = 0;
  for (const x of r) ss += (x - m) ** 2;
  const sd = Math.sqrt(ss / (n - 1));
  return sd > 0 ? m / (sd / Math.sqrt(n)) : 0;
}

export interface FeedStatsOptions { maxLag: number; vrQs: readonly number[]; minStreak: number }

/** Statistics over `candles` (the caller slices the window): returns between consecutive closes, colours of every candle but the first. */
export function computeFeedStats(candles: readonly Candle[], o: FeedStatsOptions): FeedStats {
  const r = logReturns(candles);
  const colours = candles.slice(1).map(colour);
  const n = r.length;
  const autocorr = autocorrelations(r, o.maxLag);
  const acSum = autocorr.reduce((s, x) => s + x, 0);
  const vrs = o.vrQs.map((q) => varianceRatio(r, q));
  const sr = streakReversal(colours, o.minStreak);
  return {
    n,
    autocorr,
    acSumZ: n > 0 ? (acSum + o.maxLag / n) / Math.sqrt(o.maxLag / n) : 0,
    vr: vrs.map((v) => v.vr),
    vrZ: vrs.map((v) => v.z),
    runsZ: runsZ(colours),
    streakReversalRate: sr.rate,
    streakEvents: sr.events,
    streakZ: sr.z,
    driftZ: driftZ(r),
  };
}

/** Upper tail of the standard normal, 1 - Phi(x). erfc from Numerical Recipes (fractional error < 1.2e-7). */
export function normalTail(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * z);
  const erfc = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
    t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? erfc / 2 : 1 - erfc / 2;
}
