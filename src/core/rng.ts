// Seeded randomness. The only source of randomness allowed in core, engines, features, harness
// and the in-memory ledger, so that (source, engines, seed) fully determines a run.

const UINT32 = 4294967296;

/** mulberry32: small, fast 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32;
  };
}

/** murmur3 finaliser: spreads every input bit over the output. */
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Stable 32-bit hash of a list of parts (FNV-1a over a typed encoding, then fmix32).
 * The type tag keeps hashSeed(1) and hashSeed('1') apart; the separator keeps ('ab','c') and ('a','bc') apart.
 */
export function hashSeed(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  for (const part of parts) {
    const text = (typeof part === 'number' ? 'n' : 's') + String(part) + '\u001f';
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return fmix32(h);
}

export interface RngSnapshot { state: number; spare: number | null }

/** Seeded generator with uniform, integer and normal draws. State can be saved and restored. */
export class Rng {
  private state: number;
  private spare: number | null = null;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  static fromSnapshot(s: RngSnapshot): Rng {
    const r = new Rng(0);
    r.state = s.state >>> 0;
    r.spare = s.spare;
    return r;
  }

  snapshot(): RngSnapshot {
    return { state: this.state, spare: this.spare };
  }

  /** Uniform float in [0, 1). Same sequence as mulberry32(seed). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32;
  }

  /** Uniform float in [lo, hi). */
  uniform(lo = 0, hi = 1): number {
    return lo + (hi - lo) * this.next();
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Normal draw by Box-Muller; the second value of each pair is kept for the next call. */
  normal(mean = 0, sd = 1): number {
    if (this.spare !== null) {
      const z = this.spare;
      this.spare = null;
      return mean + sd * z;
    }
    const u1 = 1 - this.next(); // (0, 1], so log(u1) is finite
    const u2 = this.next();
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;
    this.spare = r * Math.sin(theta);
    return mean + sd * r * Math.cos(theta);
  }
}
