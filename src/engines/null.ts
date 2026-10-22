// Null engine (BB_Qx.md engine 12): a seeded coin flip, scored exactly like every other engine.
// It is the bar every voter must beat. Its vote depends only on (seed, asset, tf, candleCloseAt),
// so it is pure and replays identically.

import type { Context, Engine, EngineFactory, EngineStats, Outcome, Vote } from '../core/contracts';
import { hashSeed, mulberry32 } from '../core/rng';

/** BB_Qx.md scoreboard windows: rolling accuracy over the last 100 and 200 scored votes. */
const SHORT = 100;
const LONG = 200;

interface AssetStats {
  votes: number;      // UP/DOWN votes that were scored, ties included
  abstains: number;
  hits: number;
  ties: number;
  recent: number[];   // 1 = hit, 0 = miss, non-tie scored votes, newest last (trimmed lazily to LONG)
  brierSum: number;
  brierN: number;
}

interface SerializedAsset { votes: number; abstains: number; hits: number; ties: number; recent: string; brierSum: number; brierN: number }
interface SerializedNull { engine: 'null'; version: 1; assets: Record<string, SerializedAsset> }

const empty = (): AssetStats => ({ votes: 0, abstains: 0, hits: 0, ties: 0, recent: [], brierSum: 0, brierN: 0 });

function windowAccuracy(recent: readonly number[], n: number): number | null {
  if (recent.length < n) return null;
  let s = 0;
  for (let i = recent.length - n; i < recent.length; i++) s += recent[i]!;
  return s / n;
}

function isCount(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0;
}

function parseAsset(a: unknown): AssetStats {
  const r = a as Partial<SerializedAsset> | null;
  if (!r || !isCount(r.votes) || !isCount(r.abstains) || !isCount(r.hits) || !isCount(r.ties) || !isCount(r.brierN) ||
      typeof r.brierSum !== 'number' || !Number.isFinite(r.brierSum) || typeof r.recent !== 'string' || !/^[01]*$/.test(r.recent) ||
      r.recent.length > LONG) {
    throw new Error('null engine: invalid serialized asset stats');
  }
  return {
    votes: r.votes, abstains: r.abstains, hits: r.hits, ties: r.ties, brierSum: r.brierSum, brierN: r.brierN,
    recent: [...r.recent].map((c) => (c === '1' ? 1 : 0)),
  };
}

export const nullEngine: EngineFactory = (seed: number): Engine => {
  let assets = new Map<string, AssetStats>();

  const statsOf = (asset: string): AssetStats => {
    let s = assets.get(asset);
    if (!s) assets.set(asset, (s = empty()));
    return s;
  };

  return {
    id: 'null',
    kind: 'baseline',
    warmupCandles: 0,

    vote(ctx: Context): Vote {
      const u = mulberry32(hashSeed(seed, ctx.asset, ctx.tf, ctx.candleCloseAt))();
      return { engine: 'null', direction: u < 0.5 ? 'UP' : 'DOWN', confidence: 0.5, reasons: ['coin flip'] };
    },

    onOutcome(vote: Vote, outcome: Outcome, ctx: Context): void {
      const s = statsOf(ctx.asset);
      if (vote.direction === 'ABSTAIN') { s.abstains++; return; }
      s.votes++;
      if (outcome === 'TIE') { s.ties++; return; } // ties are excluded from accuracy and calibration
      const hit = outcome === 'WIN' ? 1 : 0;
      s.hits += hit;
      s.recent.push(hit);
      if (s.recent.length > 2 * LONG) s.recent.splice(0, s.recent.length - LONG);
      s.brierSum += (vote.confidence - hit) ** 2;
      s.brierN++;
    },

    stats(asset: string): EngineStats {
      const s = assets.get(asset) ?? empty();
      return {
        votes: s.votes, abstains: s.abstains, hits: s.hits, ties: s.ties,
        last100: windowAccuracy(s.recent, SHORT), last200: windowAccuracy(s.recent, LONG),
        brier: s.brierN ? s.brierSum / s.brierN : null,
        killed: false,
      };
    },

    serialize(): SerializedNull {
      const out: Record<string, SerializedAsset> = {};
      for (const asset of [...assets.keys()].sort()) {
        const s = assets.get(asset)!;
        out[asset] = {
          votes: s.votes, abstains: s.abstains, hits: s.hits, ties: s.ties,
          recent: s.recent.slice(-LONG).join(''), brierSum: s.brierSum, brierN: s.brierN,
        };
      }
      return { engine: 'null', version: 1, assets: out };
    },

    restore(state: unknown): void {
      const st = state as Partial<SerializedNull> | null;
      if (!st || st.engine !== 'null' || st.version !== 1 || typeof st.assets !== 'object' || st.assets === null)
        throw new Error('null engine: not a serialized null engine state');
      const next = new Map<string, AssetStats>();
      for (const [asset, a] of Object.entries(st.assets)) next.set(asset, parseAsset(a));
      assets = next;
    },
  };
};
