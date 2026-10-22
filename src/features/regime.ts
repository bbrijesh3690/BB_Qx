// Range-vs-trend regime: Kaufman efficiency ratio. Near 1 the price moved in a straight line,
// near 0 it went nowhere. On a random walk ER over n steps averages about sqrt(2 / (pi * n)).

export interface Efficiency {
  /** |close[t] - close[t-n]| / sum of |close[i] - close[i-1]| over the last n steps, in 0..1. */
  er: number;
  /** Sign of the net move over the n steps. */
  dir: 1 | -1 | 0;
}

/** Null if there are fewer than n + 1 values. A series with no movement has er 0 and dir 0. */
export function efficiencyRatio(values: readonly number[], n: number): Efficiency | null {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`n must be a positive integer, got ${n}`);
  if (values.length < n + 1) return null;
  const end = values.length - 1;
  const net = values[end]! - values[end - n]!;
  let path = 0;
  for (let i = end - n + 1; i <= end; i++) path += Math.abs(values[i]! - values[i - 1]!);
  const dir = net > 0 ? 1 : net < 0 ? -1 : 0;
  return { er: path > 0 ? Math.abs(net) / path : 0, dir };
}
