// Small, exact-enough statistics for the scoreboard and the evidence tests.

import type { ScoredVote } from './contracts';

/** z for a two-sided 95% interval. */
export const Z95 = 1.959963984540054;
/** z for a two-sided 99% interval. */
export const Z99 = 2.5758293035489004;

export interface Interval { lo: number; hi: number }

/** Wilson score interval for `hits` out of `n`. n = 0 gives [0, 1]. */
export function wilson(hits: number, n: number, z = Z95): Interval {
  if (n <= 0) return { lo: 0, hi: 1 };
  const p = hits / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

/** hits / n, or null when n = 0. */
export function accuracy(hits: number, n: number): number | null {
  return n > 0 ? hits / n : null;
}

// ---------------------------------------------------------------------------
// Binomial tails
// ---------------------------------------------------------------------------

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

/** ln Gamma(x) for x > 0 (Lanczos, g = 7). */
export function lnGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const xm = x - 1;
  let a = LANCZOS[0]!;
  const t = xm + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i]! / (xm + i);
  return 0.5 * Math.log(2 * Math.PI) + (xm + 0.5) * Math.log(t) - t + Math.log(a);
}

function lnBinomPmf(k: number, n: number, p: number): number {
  if (p <= 0) return k === 0 ? 0 : -Infinity;
  if (p >= 1) return k === n ? 0 : -Infinity;
  return lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1) + k * Math.log(p) + (n - k) * Math.log(1 - p);
}

/** P(X <= k) for X ~ Binomial(n, p), summed downward from k (exact for k below the mean). */
function lowerTailDirect(k: number, n: number, p: number): number {
  let term = Math.exp(lnBinomPmf(k, n, p));
  let sum = term;
  const ratio = (1 - p) / p;
  for (let j = k; j > 0; j--) {
    term *= (j / (n - j + 1)) * ratio;
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

/** P(X >= k) for X ~ Binomial(n, p), summed upward from k (exact for k above the mean). */
function upperTailDirect(k: number, n: number, p: number): number {
  let term = Math.exp(lnBinomPmf(k, n, p));
  let sum = term;
  const ratio = p / (1 - p);
  for (let j = k; j < n; j++) {
    term *= ((n - j) / (j + 1)) * ratio;
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

/** P(X >= k) for X ~ Binomial(n, p). */
export function binomialUpperTail(k: number, n: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (k > n * p) return Math.min(1, upperTailDirect(k, n, p));
  return Math.max(0, 1 - lowerTailDirect(k - 1, n, p));
}

/** One-sided exact binomial test of H0: p = p0 against H1: p > p0. Returns the p-value P(X >= hits). */
export function binomialTestGreater(hits: number, n: number, p0 = 0.5): number {
  return binomialUpperTail(hits, n, p0);
}

// ---------------------------------------------------------------------------
// Normal distribution and power
// ---------------------------------------------------------------------------

/** Standard normal CDF (erfc with Chebyshev fit, |error| < 1.2e-7). */
export function normalCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(
    -z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
    t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
  );
  return x >= 0 ? 1 - r / 2 : r / 2;
}

/** Inverse standard normal CDF (Acklam's rational approximation, relative error < 1.2e-9). */
export function normalInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  const A = (i: number) => a[i]!, B = (i: number) => b[i]!, C = (i: number) => c[i]!, D = (i: number) => d[i]!;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((C(0) * q + C(1)) * q + C(2)) * q + C(3)) * q + C(4)) * q + C(5)) / ((((D(0) * q + D(1)) * q + D(2)) * q + D(3)) * q + 1);
  }
  if (p > 1 - lo) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((C(0) * q + C(1)) * q + C(2)) * q + C(3)) * q + C(4)) * q + C(5)) / ((((D(0) * q + D(1)) * q + D(2)) * q + D(3)) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((A(0) * r + A(1)) * r + A(2)) * r + A(3)) * r + A(4)) * r + A(5)) * q) / (((((B(0) * r + B(1)) * r + B(2)) * r + B(3)) * r + B(4)) * r + 1);
}

/**
 * Sample size for a one-sided test of p0 against p1 > p0 (normal approximation):
 * n = ((z_alpha * sqrt(p0 q0) + z_beta * sqrt(p1 q1)) / (p1 - p0))^2, rounded up.
 */
export function sampleSizeOneSided(p0: number, p1: number, alpha: number, power: number): number {
  const za = normalInv(1 - alpha);
  const zb = normalInv(power);
  const num = za * Math.sqrt(p0 * (1 - p0)) + zb * Math.sqrt(p1 * (1 - p1));
  return Math.ceil((num / (p1 - p0)) ** 2);
}

/** Smallest k with P(X >= k | n, p0) <= alpha: the critical count of the exact one-sided test. */
export function criticalCountOneSided(n: number, p0: number, alpha: number): number {
  let k = Math.max(0, Math.floor(n * p0 + normalInv(1 - alpha) * Math.sqrt(n * p0 * (1 - p0))) - 2);
  while (k > 0 && binomialUpperTail(k, n, p0) <= alpha) k--;
  while (binomialUpperTail(k, n, p0) > alpha) k++;
  return k;
}

/** Power of the exact one-sided binomial test at level alpha when the true rate is p1. */
export function exactPowerOneSided(n: number, p0: number, p1: number, alpha: number): number {
  return binomialUpperTail(criticalCountOneSided(n, p0, alpha), n, p1);
}

// ---------------------------------------------------------------------------
// Vote summaries
// ---------------------------------------------------------------------------

export interface VoteSummary {
  votes: number;        // every vote record, ABSTAIN included
  abstains: number;
  directional: number;  // UP or DOWN
  scored: number;       // directional votes with an outcome
  ties: number;
  hits: number;
  losses: number;
  n: number;            // scored minus ties: the denominator of accuracy
  accuracy: number | null;
  ci95: Interval;
}

/** Counts and accuracy (ties excluded) over a list of votes. */
export function summarizeVotes(rows: readonly ScoredVote[]): VoteSummary {
  let abstains = 0, scored = 0, ties = 0, hits = 0, losses = 0;
  for (const { vote, outcome } of rows) {
    if (vote.direction === 'ABSTAIN') { abstains++; continue; }
    if (!outcome) continue;
    scored++;
    if (outcome.result === 'TIE') ties++;
    else if (outcome.result === 'WIN') hits++;
    else losses++;
  }
  const n = hits + losses;
  return {
    votes: rows.length, abstains, directional: rows.length - abstains, scored, ties, hits, losses, n,
    accuracy: accuracy(hits, n), ci95: wilson(hits, n),
  };
}

// ---------------------------------------------------------------------------
// Series helpers
// ---------------------------------------------------------------------------

export function mean(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return xs.length ? s / xs.length : NaN;
}

/** Pearson correlation of two equal-length series. */
export function pearson(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length !== ys.length) throw new Error('pearson: series lengths differ');
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i]! - mx, dy = ys[i]! - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return sxy / Math.sqrt(sxx * syy);
}

/** Sample autocorrelation of a series at a lag. */
export function autocorr(xs: readonly number[], lag: number): number {
  const m = mean(xs);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) {
    const d = xs[i]! - m;
    den += d * d;
    if (i >= lag) num += d * (xs[i - lag]! - m);
  }
  return num / den;
}
