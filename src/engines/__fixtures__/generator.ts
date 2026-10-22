// Tiny deterministic candle generator for engine tests. Not the harness generators (core owns those).
// Per-candle AR(1) on log price: x[t+1] = x[t] + drift - k * (x[t] - anchor) + sigma * eps.
// Random walk is k = 0, drift = 0. Open = previous close; high / low sit a little outside the body.

import type { Candle } from '../../core/contracts';

export const FIXTURE_T0 = Date.UTC(2026, 0, 5); // 2026-01-05T00:00:00Z
const MINUTE = 60_000;

/** mulberry32: small, fast, good enough for test fixtures. */
export class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0; }
  /** Uniform in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Standard normal (Box-Muller). */
  normal(): number {
    const u = 1 - this.next(); // (0, 1]
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }
}

export interface GenOptions {
  n: number;
  seed: number;
  /** Pull toward the anchor per candle; 0 is a random walk. */
  k?: number;
  /** Log-price drift per candle. */
  drift?: number;
  /** Log-price noise per candle. */
  sigma?: number;
  /** Anchor price (the walk starts here). */
  anchor?: number;
  /** Wick size as a multiple of sigma * price (half-normal). */
  wickScale?: number;
  /** Round prices to this tick so that ties (close == open) can happen; 0 disables rounding. */
  tickSize?: number;
  /**
   * Optional volatility clustering (adversarial check, not part of the brief's generator):
   * sigma_t = sigma * exp(h_t), h[t+1] = volPersistence * h[t] + volOfVol * N(0, 1).
   */
  volPersistence?: number;
  volOfVol?: number;
}

export const FIXTURE_SIGMA = 0.0005;

function round(p: number, tick: number): number {
  return tick > 0 ? Math.round(p / tick) * tick : p;
}

export function generateCandles(o: GenOptions): Candle[] {
  const k = o.k ?? 0;
  const drift = o.drift ?? 0;
  const sigma = o.sigma ?? FIXTURE_SIGMA;
  const anchor = Math.log(o.anchor ?? 1.1);
  const wick = o.wickScale ?? 0.5;
  const tick = o.tickSize ?? 0.00001;
  const phi = o.volPersistence ?? 0;
  const eta = o.volOfVol ?? 0;
  const rng = new Rng(o.seed);
  let x = anchor;
  let h = 0;
  let prevClose = round(Math.exp(x), tick);
  const out: Candle[] = [];
  for (let t = 0; t < o.n; t++) {
    const sig = eta > 0 ? sigma * Math.exp(h) : sigma;
    x = x + drift - k * (x - anchor) + sig * rng.normal();
    if (eta > 0) h = phi * h + eta * rng.normal();
    const open = prevClose;
    const close = round(Math.exp(x), tick);
    const scale = wick * sig * close;
    const high = round(Math.max(open, close) + Math.abs(rng.normal()) * scale, tick);
    const low = round(Math.min(open, close) - Math.abs(rng.normal()) * scale, tick);
    out.push({ openTs: FIXTURE_T0 + t * MINUTE, open, high, low, close, tickCount: 60 });
    prevClose = close;
  }
  return out;
}

export type FeedKind = 'random' | 'bounded-0.08' | 'bounded-0.2' | 'trending';

/** The four fixture feeds used across engine tests. Trending drift is 0.1 sigma per candle (P(up) about 54%). */
export function feedOptions(kind: FeedKind): Pick<GenOptions, 'k' | 'drift'> {
  switch (kind) {
    case 'random': return { k: 0, drift: 0 };
    case 'bounded-0.08': return { k: 0.08, drift: 0 };
    case 'bounded-0.2': return { k: 0.2, drift: 0 };
    case 'trending': return { k: 0, drift: 0.1 * FIXTURE_SIGMA };
  }
}
