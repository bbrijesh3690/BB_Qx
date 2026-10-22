// Server-time offset from tick timestamps: median of (serverTs - localReceive) over recent ticks.
// The estimate folds in network latency (ticks arrive after they are stamped), which is what we
// want: "server time now" as seen through this connection.

const DEFAULT_WINDOW = 200; // TUNABLE: ~1-3 minutes of ticks on a few assets; long enough to ignore one slow frame

export class OffsetEstimator {
  private readonly samples: number[] = [];
  private next = 0;
  private cached: number | null = null;

  constructor(private readonly window = DEFAULT_WINDOW) {}

  add(serverTs: number, localTs: number): void {
    const d = serverTs - localTs;
    if (!Number.isFinite(d)) return;
    if (this.samples.length < this.window) this.samples.push(d);
    else {
      this.samples[this.next] = d;
      this.next = (this.next + 1) % this.window;
    }
    this.cached = null;
  }

  /** Median offset in ms (server minus local), or null before the first tick. */
  offset(): number | null {
    if (this.samples.length === 0) return null;
    if (this.cached === null) this.cached = median(this.samples);
    return this.cached;
  }

  get size(): number {
    return this.samples.length;
  }
}

export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
