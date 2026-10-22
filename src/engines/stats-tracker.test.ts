import { describe, expect, it } from 'vitest';
import type { Direction, Outcome, Vote } from '../core/contracts';
import { StatsTracker } from './stats-tracker';

const v = (direction: Direction, confidence = 0.6): Vote => ({ engine: 'x', direction, confidence, reasons: [] });

describe('StatsTracker', () => {
  it('counts votes, abstains, hits and ties; brier over non-tie votes', () => {
    const t = new StatsTracker();
    t.record('A', v('UP', 0.6), 'WIN');     // (0.6 - 1)^2 = 0.16
    t.record('A', v('DOWN', 0.7), 'LOSS');  // (0.7 - 0)^2 = 0.49
    t.record('A', v('UP', 0.9), 'TIE');     // excluded from accuracy and brier
    t.record('A', v('ABSTAIN', 0.5), 'WIN'); // counted as abstain only
    const s = t.stats('A');
    expect(s).toEqual({ votes: 3, abstains: 1, hits: 1, ties: 1, last100: null, last200: null, brier: s.brier, killed: false });
    expect(s.brier).toBeCloseTo((0.16 + 0.49) / 2, 12);
  });

  it('empty and unknown assets', () => {
    expect(new StatsTracker().stats('nope')).toEqual({ votes: 0, abstains: 0, hits: 0, ties: 0, last100: null, last200: null, brier: null, killed: false });
  });

  it('last100 / last200 need that many non-tie votes and cover the most recent ones', () => {
    const t = new StatsTracker();
    // 60 losses, then 140 wins with a tie after every 10th: 200 non-tie votes in all
    for (let i = 0; i < 60; i++) t.record('A', v('UP'), 'LOSS');
    for (let i = 0; i < 139; i++) {
      t.record('A', v('UP'), 'WIN');
      if (i % 10 === 0) t.record('A', v('UP'), 'TIE');
    }
    expect(t.stats('A').last100).toBe(1);
    expect(t.stats('A').last200).toBeNull(); // 199 non-tie so far
    t.record('A', v('UP'), 'WIN');
    expect(t.stats('A').last200).toBe(140 / 200);
    for (let i = 0; i < 50; i++) t.record('A', v('UP'), 'LOSS');
    expect(t.stats('A').last100).toBe(50 / 100);
    expect(t.stats('A').last200).toBe(140 / 200); // 50 of the first 60 losses rolled out: 10 L, 140 W, 50 L
    expect(t.stats('A').hits).toBe(140);
  });

  it('keeps assets apart', () => {
    const t = new StatsTracker();
    t.record('A', v('UP'), 'WIN');
    t.record('B', v('UP'), 'LOSS');
    expect(t.stats('A').hits).toBe(1);
    expect(t.stats('B').hits).toBe(0);
  });

  it('serialize / restore round-trips through JSON', () => {
    const t = new StatsTracker();
    const outcomes: Outcome[] = ['WIN', 'LOSS', 'TIE'];
    for (let i = 0; i < 450; i++) t.record(i % 3 === 0 ? 'B' : 'A', v(i % 7 === 0 ? 'ABSTAIN' : 'UP', 0.55), outcomes[(i * 5) % 3]!);
    const u = new StatsTracker();
    u.restore(JSON.parse(JSON.stringify(t.serialize())));
    expect(u.stats('A')).toEqual(t.stats('A'));
    expect(u.stats('B')).toEqual(t.stats('B'));
    expect(u.serialize()).toEqual(t.serialize());
    expect(Object.keys(t.serialize().assets)).toEqual(['A', 'B']);
  });

  it('refuses malformed state', () => {
    const t = new StatsTracker();
    expect(() => t.restore(null)).toThrow(TypeError);
    expect(() => t.restore({ version: 2, assets: {} })).toThrow(TypeError);
    expect(() => t.restore({ version: 1, assets: { A: { votes: -1 } } })).toThrow(TypeError);
    expect(() => t.restore({ version: 1, assets: { A: { votes: 1, abstains: 0, hits: 0, ties: 0, recent: [2], brierSum: 0, brierN: 0 } } })).toThrow(TypeError);
  });
});
