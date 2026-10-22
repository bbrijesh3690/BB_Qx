import { describe, expect, it } from 'vitest';
import type { PanelSnapshot, RecorderView } from '../shared/messages';
import {
  ageText, aliveDot, candleColour, defaultSpotAsset, durationText, headerDot, mbText, priceDecimals, recorderText,
  storedText, unknownSummary, utcMinute,
} from './view';

const rec = (over: Partial<RecorderView> = {}): RecorderView => ({
  on: true, startedAt: 0, stoppedReason: null, framesThisRun: 1234, framesStored: 5678, approxMB: 3.456,
  timeLeftMs: 5 * 3_600_000 + 7 * 60_000, frameCap: 3_000_000, ...over,
});

function snapshot(over: Partial<PanelSnapshot> = {}): PanelSnapshot {
  return {
    now: 0, selfTabId: 2, serverOffsetMs: null, framesSeen: 10, tabs: [], assets: [], recorder: rec(), unknownEvents: [],
    decode: { ticks: 0, duplicateTicks: 0, staleTicks: 0, ticksRejected: 0, candles: 0, candlesRejected: 0, candlesSkippedOpen: 0, payouts: 0, badPayloads: 0, orphanBinaries: 0, unknownFrames: 0 },
    errors: [], ...over,
  };
}

const asset = (name: string, age: number | null) => ({ asset: name, name: null, isOTC: false, ticksStored: 1, candles1m: 0, lastTickAgeMs: age, payout: null, tabs: [] });
const tab = (tabId: number, viewing: string | null, assets: string[]) => ({ tabId, socketUrls: [], viewing, assets, lastFrameAt: 0, frames: 0, tap: null });

describe('panel view helpers', () => {
  it('turns the feed-alive dot red after 10 s and grey when there is no tick', () => {
    expect(aliveDot(null)).toBe('grey');
    expect(aliveDot(10_000)).toBe('green');
    expect(aliveDot(10_001)).toBe('red');
  });

  it('formats ages and durations', () => {
    expect(ageText(null)).toBe('—');
    expect(ageText(450)).toBe('0.5s');
    expect(ageText(12_400)).toBe('12s');
    expect(ageText(125_000)).toBe('2m');
    expect(durationText(3 * 3_600_000 + 5 * 60_000)).toBe('3h 5m');
    expect(durationText(50 * 3_600_000)).toBe('2d 2h');
  });

  it('colours candles green, red or doji', () => {
    expect(candleColour({ open: 1, close: 2 })).toBe('green');
    expect(candleColour({ open: 2, close: 1 })).toBe('red');
    expect(candleColour({ open: 1.5, close: 1.5 })).toBe('doji');
  });

  it('prints UTC minutes and one decimal count per list', () => {
    expect(utcMinute(Date.UTC(2026, 9, 22, 14, 5, 59))).toBe('2026-10-22 14:05');
    const row = (o: number, c: number) => ({ openTs: 0, open: o, high: Math.max(o, c), low: Math.min(o, c), close: c, source: 'feed' as const });
    expect(priceDecimals([row(1.07123, 1.0712), row(1.1, 1.2)])).toBe(5);
    expect(priceDecimals([row(150, 151)])).toBe(0);
    expect(priceDecimals([row(1e-9, 1)])).toBe(6);
  });

  it('describes the recorder', () => {
    expect(recorderText(rec())).toBe('ON · 1,234 / 3,000,000 frames this run · 5h 7m left');
    expect(recorderText(rec({ on: false, stoppedReason: 'time', timeLeftMs: null }))).toBe('OFF (stopped at its time limit)');
    expect(recorderText(rec({ on: false, stoppedReason: 'cap' }))).toBe('OFF (stopped at frame cap)');
    expect(storedText(rec())).toBe('5,678 frames stored · ~3.46 MB');
    expect(mbText(1234.4)).toBe('1,234 MB');
  });

  it('picks the header dot from the assets', () => {
    expect(headerDot(null)).toBe('grey');
    expect(headerDot(snapshot({ framesSeen: 0 }))).toBe('grey');
    expect(headerDot(snapshot({ assets: [asset('A', 20_000)] }))).toBe('red');
    expect(headerDot(snapshot({ assets: [asset('A', 20_000), asset('B', 300)] }))).toBe('green');
  });

  it('chooses the spot-check asset: current, then this tab’s view, then what it feeds, then the first', () => {
    const assets = [asset('A', 1), asset('B', 1), asset('C', 1)];
    expect(defaultSpotAsset(snapshot({ assets, tabs: [tab(2, 'B', ['C'])] }), 'A')).toBe('A');
    expect(defaultSpotAsset(snapshot({ assets, tabs: [tab(2, 'B', ['C'])] }), null)).toBe('B');
    expect(defaultSpotAsset(snapshot({ assets, tabs: [tab(2, 'Z', ['C'])] }), 'gone')).toBe('C');
    expect(defaultSpotAsset(snapshot({ assets, tabs: [] }), null)).toBe('A');
    expect(defaultSpotAsset(snapshot({ assets: [] }), null)).toBeNull();
  });

  it('summarises unknown event names', () => {
    expect(unknownSummary(snapshot())).toBe('none');
    const unknownEvents = [{ name: 'in a', count: 3 }, { name: 'in b', count: 2 }, { name: 'out c', count: 1 }];
    expect(unknownSummary(snapshot({ unknownEvents }), 2)).toBe('3 names, 6 frames: in a ×3, in b ×2, +1 more');
  });
});
