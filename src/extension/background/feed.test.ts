// Frames here are hand-built to the decoder's HYPOTHESES (see decoder.ts), not real Quotex traffic.
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { openIndexedDbLedger, type IndexedDbLedger } from '../../ledger/indexeddb';
import { bytesToBase64, utf8Encode } from '../quotex/bytes';
import { FEED_CHANNEL, type TapBatch, type TapFrame } from '../shared/messages';
import { FeedProcessor } from './feed';
import { initialRecorder, RECORDER_FRAME_CAP, setRecorder, type RecorderState } from './recorder';
import { createDirectSink, type FeedSink } from './sink';
import { buildSnapshot, candleRows } from './snapshot';

const URL_A = 'wss://ws2.qxbroker.com/socket.io/?EIO=3&transport=websocket';
const T = 1_792_670_400; // server seconds
const LOCAL = T * 1000 - 2_000; // local clock runs 2 s behind the server

let n = 0;

async function setup(opts: { recorder?: RecorderState; sink?: (l: IndexedDbLedger) => FeedSink } = {}) {
  const ledger = await openIndexedDbLedger(`feed-test-${++n}`);
  let recorder = opts.recorder ?? initialRecorder(LOCAL);
  const proc = new FeedProcessor({
    frames: ledger,
    sink: opts.sink ? opts.sink(ledger) : createDirectSink(ledger),
    getRecorder: () => recorder,
    setRecorder: (s) => (recorder = s),
  });
  return { ledger, proc, recorder: () => recorder };
}

const text = (data: string, dir: 'in' | 'out' = 'in', t = LOCAL, sid = 1): TapFrame => ({ sid, url: URL_A, dir, enc: 'text', data, t });
const binary = (json: string, t = LOCAL, sid = 1): TapFrame => ({
  sid, url: URL_A, dir: 'in', enc: 'base64', data: bytesToBase64(new Uint8Array([4, ...utf8Encode(json)])), t,
});
const batch = (frames: TapFrame[]): TapBatch => ({ channel: FEED_CHANNEL, type: 'batch', frames });
const quotes = (rows: [string, number, number][], t = LOCAL) => [
  text('451-["quotes/stream",{"_placeholder":true,"num":0}]', 'in', t),
  binary(JSON.stringify(rows.map((r) => [...r, 0])), t),
];

describe('FeedProcessor', () => {
  it('decodes ticks from two tabs into the ledger once, and knows which tabs feed which asset', async () => {
    const { ledger, proc } = await setup();
    const frames = quotes([['EURUSD_otc', T + 0.25, 1.1], ['EURUSD_otc', T + 0.5, 1.2]]);
    await proc.handleBatch(11, 0, batch([text('42["instruments/update",{"asset":"EURUSD_otc","period":60}]', 'out'), ...frames]), LOCAL);
    await proc.handleBatch(22, 0, batch([text('42["depth/follow","GBPUSD"]', 'out'), ...frames]), LOCAL);
    expect((await ledger.getTicks('EURUSD_otc')).map((t) => [t.ts, t.price])).toEqual([[T * 1000 + 250, 1.1], [T * 1000 + 500, 1.2]]);
    expect(proc.decodeView()).toMatchObject({ ticks: 4, duplicateTicks: 2, staleTicks: 0 });
    expect(proc.assetViews(LOCAL)).toEqual([{ asset: 'EURUSD_otc', lastTickLocal: LOCAL, tabs: [11, 22] }]);
    const tabs = proc.tabViews();
    expect(tabs.map((t) => [t.tabId, t.viewing, t.assets, t.frames])).toEqual([
      [11, 'EURUSD_otc', ['EURUSD_otc'], 3],
      [22, 'GBPUSD', ['EURUSD_otc'], 3],
    ]);
    expect(tabs[0]!.socketUrls).toEqual([URL_A]);
  });

  it('estimates the server offset from ticks and emits monotonic clock events only while a feed is active', async () => {
    const { proc } = await setup();
    expect(proc.clockEvent(LOCAL)).toBeNull();
    await proc.handleBatch(1, 0, batch(quotes([['A_otc', T, 1]])), LOCAL);
    expect(proc.offset.offset()).toBe(2000);
    expect(proc.clockEvent(LOCAL + 1000)).toEqual({ kind: 'clock', ts: T * 1000 + 1000 });
    expect(proc.clockEvent(LOCAL + 1000)).toBeNull();
    expect(proc.clockEvent(LOCAL + 2000)).toEqual({ kind: 'clock', ts: T * 1000 + 2000 });
    expect(proc.clockEvent(LOCAL + 11_000)).toBeNull();
  });

  it('stores raw frames redacted, tagged by tab, and decodes the redacted copy', async () => {
    const { ledger, proc } = await setup();
    await proc.handleBatch(7, 0, batch([
      text('42["authorization",{"session":"SECRET-SESSION","isDemo":1}]', 'out'),
      text('42["settings/store",{"token":"SECRET-TOKEN","chartId":"x"}]', 'out'),
      ...quotes([['A_otc', T, 1]]),
    ]), LOCAL);
    const raw = await ledger.listRawFrames({ tabId: 7 });
    expect(raw).toHaveLength(4);
    expect(JSON.stringify(raw)).not.toContain('SECRET');
    expect(raw[0]).toMatchObject({ tabId: 7, dir: 'out', encoding: 'text', data: '42["authorization","[redacted]"]', receivedAt: LOCAL, socketUrl: URL_A });
    expect(raw[3]!.encoding).toBe('base64');
    expect(await ledger.getTicks('A_otc')).toHaveLength(1);
    expect(proc.unknownEvents()).toEqual([{ name: 'out authorization', count: 1 }, { name: 'out settings/store', count: 1 }]);
  });

  it('stops storing raw frames when the recorder is off or the cap is reached, but keeps decoding', async () => {
    const off = await setup({ recorder: setRecorder(initialRecorder(LOCAL), false, LOCAL) });
    await off.proc.handleBatch(1, 0, batch(quotes([['A_otc', T, 1]])), LOCAL);
    expect(await off.ledger.countRawFrames()).toBe(0);
    expect(await off.ledger.getTicks('A_otc')).toHaveLength(1);

    const nearCap = await setup({ recorder: { ...initialRecorder(LOCAL), framesThisRun: RECORDER_FRAME_CAP - 1 } });
    await nearCap.proc.handleBatch(1, 0, batch(quotes([['A_otc', T, 1]])), LOCAL);
    expect(await nearCap.ledger.countRawFrames()).toBe(1);
    expect(nearCap.recorder()).toMatchObject({ on: false, stoppedReason: 'cap', framesThisRun: RECORDER_FRAME_CAP });
    expect(nearCap.recorder().bytesTotal).toBeGreaterThan(0);
  });

  it('writes only closed history candles as feed candles and payouts on change', async () => {
    const { ledger, proc } = await setup();
    const base = T - (T % 60) - 300;
    const hist = { asset: 'A_otc', period: 60, candles: [[base, 1, 1.1, 1.2, 0.9], [base + 60, 1.1, 1.0, 1.15, 0.95], [base + 300, 1, 1, 1, 1]] };
    await proc.handleBatch(1, 0, batch([
      ...quotes([['A_otc', T, 1]]),
      text(`42["history/list/v2",${JSON.stringify(hist)}]`),
      text('42["instruments/list",[[1,"A_otc","A (OTC)","currency",2,91]]]'),
    ]), LOCAL);
    const candles = await ledger.getCandles('A_otc', '1m');
    expect(candles.map((c) => [c.openTs / 1000 - base, c.source])).toEqual([[0, 'feed'], [60, 'feed']]);
    expect((await ledger.latestPayout('A_otc', T * 1000 + 5000))?.percent).toBe(91);
    expect(await candleRows(ledger, 'A_otc', 50)).toEqual([
      { openTs: base * 1000, open: 1, high: 1.2, low: 0.9, close: 1.1, source: 'feed' },
      { openTs: (base + 60) * 1000, open: 1.1, high: 1.15, low: 0.95, close: 1.0, source: 'feed' },
    ]);
  });

  it('pairs binary attachments per socket even when frames from two sockets interleave', async () => {
    const { ledger, proc } = await setup();
    await proc.handleBatch(1, 0, batch([
      { ...text('451-["quotes/stream",{"_placeholder":true,"num":0}]'), sid: 1 },
      { ...text('451-["quotes/stream",{"_placeholder":true,"num":0}]'), sid: 2 },
      binary('[["B",1792670401,2,0]]', LOCAL, 2),
      binary('[["A",1792670401,1,0]]', LOCAL, 1),
    ]), LOCAL);
    expect((await ledger.getTicks('A')).map((t) => t.price)).toEqual([1]);
    expect((await ledger.getTicks('B')).map((t) => t.price)).toEqual([2]);
  });

  it('records sink failures as visible errors instead of throwing', async () => {
    const failing: FeedSink = { onEvent: async () => { throw new Error('quota exceeded'); } };
    const { proc } = await setup({ sink: () => failing });
    await expect(proc.handleBatch(1, 0, batch(quotes([['A', T, 1]])), LOCAL)).resolves.toBeUndefined();
    expect(proc.errors.at(-1)).toContain('quota exceeded');
  });

  it('survives a worker restart through persist and restore', async () => {
    const { proc } = await setup();
    await proc.handleBatch(3, 0, batch([text('42["mystery",1]'), ...quotes([['A_otc', T, 1]])]), LOCAL);
    proc.handleStatus(3, 0, { channel: FEED_CHANNEL, type: 'status', sockets: 1, frames: 3, errors: 0, dropped: 0 });
    const saved = JSON.parse(JSON.stringify(proc.persist()));

    const again = await setup();
    again.proc.restore(saved);
    expect(again.proc.unknownEvents()).toEqual([{ name: 'in mystery', count: 1 }]);
    expect(again.proc.tabViews().map((t) => [t.tabId, t.assets])).toEqual([[3, ['A_otc']]]);
    expect(again.proc.decodeView().ticks).toBe(1);
    expect(again.proc.gate.accept('A_otc', T * 1000)).toBe('duplicate');
  });

  it('forgets a closed tab', async () => {
    const { proc } = await setup();
    await proc.handleBatch(5, 0, batch(quotes([['A', T, 1]])), LOCAL);
    proc.removeTab(5);
    expect(proc.tabViews()).toEqual([]);
    expect(proc.assetViews(LOCAL)[0]!.tabs).toEqual([]);
  });

  it('builds the panel snapshot from processor state and ledger counts', async () => {
    const { ledger, proc, recorder } = await setup();
    await proc.handleBatch(9, 0, batch([...quotes([['EURUSD_otc', T, 1.1], ['EURUSD_otc', T + 1, 1.2]]), text('42["instruments/list",[[1,"EURUSD_otc","x","c",2,87]]]')]), LOCAL);
    const snap = await buildSnapshot(proc, ledger, recorder(), LOCAL + 500);
    expect(snap.assets).toEqual([{ asset: 'EURUSD_otc', isOTC: true, ticksStored: 2, candles1m: 0, lastTickAgeMs: 500, payout: 87, tabs: [9] }]);
    expect(snap.recorder).toMatchObject({ on: true, framesThisRun: 3, framesStored: 3 });
    expect(snap.recorder.approxMB).toBeGreaterThan(0);
    expect(snap.serverOffsetMs).toBe(2500); // median of 2000 and 3000
    expect(snap.tabs[0]).toMatchObject({ tabId: 9, assets: ['EURUSD_otc'] });
    expect(snap.framesSeen).toBe(3);
  });
});
