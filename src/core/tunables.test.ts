import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listTunables, tunable, TUNABLES } from './tunables';

const ROOT = resolve(__dirname, '../..');

describe('tunables registry', () => {
  it('holds the phase 0 values', () => {
    expect(tunable('freezeBeforeCloseMs')).toBe(5000);
    expect(tunable('confirmDelayMs')).toBe(2000);
    expect(TUNABLES.defaultPayoutPercent.unit).toBe('percent');
  });

  it('every entry has a reason, a unit and a finite value, listed by name', () => {
    const all = listTunables();
    expect(all.length).toBeGreaterThan(5);
    expect(all.map((t) => t.name)).toEqual([...all.map((t) => t.name)].sort());
    for (const t of all) {
      expect(t.reason.length, t.name).toBeGreaterThan(10);
      expect(t.unit.length, t.name).toBeGreaterThan(0);
      expect(Number.isFinite(t.value), t.name).toBe(true);
      expect(t.source, t.name).toMatch(/^src\//);
    }
  });

  it('every entry is used, and marked TUNABLE, in its source file', () => {
    for (const t of listTunables()) {
      const file = resolve(ROOT, t.source);
      expect(existsSync(file), `${t.name}: ${t.source}`).toBe(true);
      const text = readFileSync(file, 'utf8');
      expect(text, `${t.name} is not referenced in ${t.source}`).toMatch(new RegExp(`TUNABLE[^\\n]*${t.name}`));
    }
  });
});
