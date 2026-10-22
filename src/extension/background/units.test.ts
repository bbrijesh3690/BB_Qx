import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { openIndexedDbLedger } from '../../ledger/indexeddb';
import { median, OffsetEstimator } from './clock';
import { TickGate } from './dedupe';
import { allowance, checkRecorder, initialRecorder, recordFrames, RECORDER_MAX_MS, setRecorder, timeLeftMs } from './recorder';
import { createDirectSink } from './sink';

describe('OffsetEstimator', () => {
  it('is null before any tick and the median of server minus local after', () => {
    const e = new OffsetEstimator(5);
    expect(e.offset()).toBeNull();
    e.add(1100, 1000);
    e.add(1300, 1000);
    e.add(1200, 1000);
    expect(e.offset()).toBe(200);
    e.add(5000, 1000); // one outlier does not move the median much
    expect(e.offset()).toBe(250);
  });

  it('keeps only the most recent window of samples', () => {
    const e = new OffsetEstimator(3);
    for (const d of [10, 10, 10, 50, 50, 50]) e.add(1000 + d, 1000);
    expect(e.size).toBe(3);
    expect(e.offset()).toBe(50);
  });

  it('computes medians of odd and even lists', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('TickGate', () => {
  it('passes new ticks, rejects duplicates and late ticks per asset', () => {
    const g = new TickGate();
    expect(g.accept('A', 100)).toBe('new');
    expect(g.accept('A', 100)).toBe('duplicate');
    expect(g.accept('A', 200)).toBe('new');
    expect(g.accept('A', 100)).toBe('duplicate');
    expect(g.accept('A', 150)).toBe('stale');
    expect(g.accept('B', 150)).toBe('new');
    expect(g.lastTs('A')).toBe(200);
  });

  it('can be seeded after a restart', () => {
    const g = new TickGate();
    g.seed('A', 500);
    expect(g.accept('A', 500)).toBe('duplicate');
    expect(g.accept('A', 400)).toBe('stale');
    expect(g.accept('A', 600)).toBe('new');
    expect(g.entries()).toEqual([['A', 600]]);
  });
});

describe('recorder state', () => {
  it('starts on, stops at its time limit or the frame cap, and restarts with a fresh run', () => {
    let s = initialRecorder(0);
    expect(s.on).toBe(true);
    expect(allowance(s, 10)).toBe(10);
    s = recordFrames(s, 7, 700);
    expect(allowance(s, 10)).toBe(3);
    expect(checkRecorder(s, 1000, 10)).toBe(s);
    expect(checkRecorder(recordFrames(s, 3, 1), 1000, 10)).toMatchObject({ on: false, stoppedReason: 'cap' });
    expect(checkRecorder(s, RECORDER_MAX_MS, 10)).toMatchObject({ on: false, stoppedReason: 'time' });
    expect(timeLeftMs(s, 1000)).toBe(RECORDER_MAX_MS - 1000);

    const off = setRecorder(s, false, 5);
    expect(off).toMatchObject({ on: false, stoppedReason: 'manual' });
    expect(allowance(off, 10)).toBe(0);
    expect(timeLeftMs(off, 5)).toBeNull();
    const again = setRecorder(off, true, 99);
    expect(again).toMatchObject({ on: true, startedAt: 99, framesThisRun: 0, bytesTotal: 700, stoppedReason: null });
  });
});

describe('createDirectSink', () => {
  it('writes ticks on flush, payouts and feed candles immediately, and ignores clock events', async () => {
    const ledger = await openIndexedDbLedger('sink-test');
    const sink = createDirectSink(ledger);
    await sink.onEvent({ kind: 'tick', asset: 'A_otc', isOTC: true, ts: 1, price: 1.5 });
    await sink.onEvent({ kind: 'tick', asset: 'A_otc', isOTC: true, ts: 1, price: 1.6 });
    await sink.onEvent({ kind: 'payout', asset: 'A_otc', isOTC: true, ts: 5, percent: 88 });
    await sink.onEvent({ kind: 'candle', asset: 'A_otc', isOTC: true, tf: '1m', candle: { openTs: 60_000, open: 1, high: 2, low: 0.5, close: 1.5, tickCount: 0 } });
    await sink.onEvent({ kind: 'clock', ts: 10 });
    expect(await ledger.getTicks('A_otc')).toEqual([]);
    await sink.flush!();
    expect(await ledger.getTicks('A_otc')).toEqual([{ asset: 'A_otc', ts: 1, price: 1.5 }]);
    expect(await ledger.latestPayout('A_otc', 10)).toEqual({ asset: 'A_otc', ts: 5, percent: 88 });
    expect(await ledger.getCandles('A_otc', '1m')).toEqual([
      { openTs: 60_000, open: 1, high: 2, low: 0.5, close: 1.5, tickCount: 0, asset: 'A_otc', isOTC: true, tf: '1m', source: 'feed' },
    ]);
  });
});
