import { describe, expect, it } from 'vitest';
import { ledgerConformance } from './conformance';
import { compareKeys, MemoryLedger } from './memory';

ledgerConformance('memory', async () => new MemoryLedger());

describe('MemoryLedger internals', () => {
  it('compareKeys follows IndexedDB order: numbers before strings, element by element', () => {
    expect(compareKeys([1], ['a'])).toBeLessThan(0);
    expect(compareKeys(['a', 10], ['a', 9])).toBeGreaterThan(0);
    expect(compareKeys(['a', 10], ['a', 'all'])).toBeLessThan(0);
    expect(compareKeys(['B'], ['a'])).toBeLessThan(0); // code units, not locale
    expect(compareKeys(['a'], ['a', 1])).toBeLessThan(0);
    expect(compareKeys(['x', 1], ['x', 1])).toBe(0);
  });

  it('handles a large in-order tick stream quickly', async () => {
    const l = new MemoryLedger();
    const batch = Array.from({ length: 200_000 }, (_, i) => ({ asset: 'A', ts: i * 1000, price: 1 + i * 1e-6 }));
    await l.appendTicks(batch);
    await l.appendTicks(batch.slice(0, 1000)); // all duplicates
    expect((await l.getTicks('A', { fromTs: 1000 * 1000, toTs: 1000 * 1005 })).length).toBe(5);
    expect((await l.export({ includeTicks: true })).ticks).toHaveLength(200_000);
  });
});
