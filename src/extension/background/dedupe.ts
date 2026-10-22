// Several tabs can feed the same asset, so the same tick arrives more than once, and a slower tab
// can deliver it after a newer one. Downstream (the pipeline) wants each tick once and in ts order
// per asset, so only ticks newer than the last accepted one pass.

const RECENT = 512; // TUNABLE: remembered timestamps per asset, to tell a duplicate from a late tick

export type TickVerdict = 'new' | 'duplicate' | 'stale';

export class TickGate {
  private readonly last = new Map<string, number>();
  private readonly recent = new Map<string, { set: Set<number>; order: number[] }>();

  accept(asset: string, ts: number): TickVerdict {
    const last = this.last.get(asset);
    let r = this.recent.get(asset);
    if (!r) {
      r = { set: new Set(), order: [] };
      this.recent.set(asset, r);
    }
    if (last !== undefined && ts <= last) return r.set.has(ts) || ts === last ? 'duplicate' : 'stale';
    this.last.set(asset, ts);
    r.set.add(ts);
    r.order.push(ts);
    if (r.order.length > RECENT) r.set.delete(r.order.shift()!);
    return 'new';
  }

  lastTs(asset: string): number | undefined {
    return this.last.get(asset);
  }

  /** Restores the last accepted ts per asset after a worker restart. */
  seed(asset: string, ts: number): void {
    const cur = this.last.get(asset);
    if (cur === undefined || ts > cur) this.last.set(asset, ts);
  }

  entries(): [string, number][] {
    return [...this.last.entries()];
  }
}
