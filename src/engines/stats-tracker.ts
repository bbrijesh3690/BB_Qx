// Per-asset engine statistics, updated in onOutcome. The lead consolidates this with the null engine's tracker at merge.
//
// votes   UP / DOWN votes that were scored (ties included)
// abstains ABSTAIN votes passed to onOutcome (the pipeline may never pass them; then this stays 0)
// hits    WIN outcomes
// ties    TIE outcomes
// last100 / last200  accuracy over the most recent 100 / 200 non-tie scored votes, null until that many exist
// brier   mean (confidence - won)^2 over non-tie scored votes, null if none

import type { EngineStats, Outcome, Vote } from '../core/contracts';

const RECENT_MAX = 200;

interface AssetState {
  votes: number;
  abstains: number;
  hits: number;
  ties: number;
  /** 1 = WIN, 0 = LOSS, most recent last, at most RECENT_MAX entries. */
  recent: number[];
  brierSum: number;
  brierN: number;
}

export interface StatsTrackerState { version: 1; assets: Record<string, AssetState> }

function empty(): AssetState {
  return { votes: 0, abstains: 0, hits: 0, ties: 0, recent: [], brierSum: 0, brierN: 0 };
}

function accuracyOfLast(recent: readonly number[], n: number): number | null {
  if (recent.length < n) return null;
  let s = 0;
  for (let i = recent.length - n; i < recent.length; i++) s += recent[i]!;
  return s / n;
}

function isCount(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0;
}

function parseAsset(x: unknown): AssetState | null {
  if (typeof x !== 'object' || x === null) return null;
  const a = x as Record<string, unknown>;
  const recent = a['recent'];
  if (!isCount(a['votes']) || !isCount(a['abstains']) || !isCount(a['hits']) || !isCount(a['ties']) || !isCount(a['brierN'])) return null;
  if (typeof a['brierSum'] !== 'number' || !Number.isFinite(a['brierSum'])) return null;
  if (!Array.isArray(recent) || recent.length > RECENT_MAX || !recent.every((v) => v === 0 || v === 1)) return null;
  return {
    votes: a['votes'], abstains: a['abstains'], hits: a['hits'], ties: a['ties'],
    recent: [...(recent as number[])], brierSum: a['brierSum'], brierN: a['brierN'],
  };
}

export class StatsTracker {
  private assets = new Map<string, AssetState>();

  record(asset: string, vote: Vote, outcome: Outcome): void {
    let s = this.assets.get(asset);
    if (!s) { s = empty(); this.assets.set(asset, s); }
    if (vote.direction === 'ABSTAIN') { s.abstains++; return; }
    s.votes++;
    if (outcome === 'TIE') { s.ties++; return; }
    const won = outcome === 'WIN' ? 1 : 0;
    s.hits += won;
    s.recent.push(won);
    if (s.recent.length > RECENT_MAX) s.recent.shift();
    s.brierSum += (vote.confidence - won) ** 2;
    s.brierN++;
  }

  stats(asset: string): EngineStats {
    const s = this.assets.get(asset) ?? empty();
    return {
      votes: s.votes, abstains: s.abstains, hits: s.hits, ties: s.ties,
      last100: accuracyOfLast(s.recent, 100),
      last200: accuracyOfLast(s.recent, 200),
      brier: s.brierN > 0 ? s.brierSum / s.brierN : null,
      killed: false,
    };
  }

  serialize(): StatsTrackerState {
    const assets: Record<string, AssetState> = {};
    for (const key of [...this.assets.keys()].sort()) {
      const s = this.assets.get(key)!;
      assets[key] = { ...s, recent: [...s.recent] };
    }
    return { version: 1, assets };
  }

  /** Replaces all state. Throws on a malformed state rather than silently starting from zero. */
  restore(state: unknown): void {
    if (typeof state !== 'object' || state === null || (state as { version?: unknown }).version !== 1) {
      throw new TypeError('StatsTracker.restore: expected { version: 1, assets }');
    }
    const raw = (state as { assets?: unknown }).assets;
    if (typeof raw !== 'object' || raw === null) throw new TypeError('StatsTracker.restore: missing assets');
    const next = new Map<string, AssetState>();
    for (const [asset, v] of Object.entries(raw)) {
      const parsed = parseAsset(v);
      if (!parsed) throw new TypeError(`StatsTracker.restore: malformed state for asset ${asset}`);
      next.set(asset, parsed);
    }
    this.assets = next;
  }
}
