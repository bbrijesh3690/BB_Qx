// Every frame in this file is HAND-BUILT to match the hypotheses in QUOTEX_SCHEMA. None of it is
// real Quotex traffic; when the recording shows the real shapes, these tests change with the table.
import { describe, expect, it } from 'vitest';
import { bytesToBase64, utf8Encode } from './bytes';
import { isOtcAsset, QuotexDecoder, toMs } from './decoder';
import { BinaryAssembler, parseFrame, parseText, type SocketEvent } from './socketio';

const NOW = Date.UTC(2026, 9, 22, 12, 0, 30);
const MIN = 60_000;

/** Runs frames through the real parser and assembler, returning assembled events. */
function assemble(frames: ({ text: string } | { json: string; prefix04?: boolean })[]): SocketEvent[] {
  const asm = new BinaryAssembler();
  const out: SocketEvent[] = [];
  for (const f of frames) {
    let pkt;
    if ('text' in f) pkt = parseText(f.text);
    else {
      const body = utf8Encode(f.json);
      const bytes = f.prefix04 ? new Uint8Array([4, ...body]) : body;
      pkt = parseFrame({ encoding: 'base64', data: bytesToBase64(bytes) });
    }
    const ev = asm.push(pkt);
    if (ev) out.push(ev);
  }
  return out;
}

const header = (name: string) => ({ text: `451-["${name}",{"_placeholder":true,"num":0}]` });

describe('hypothesis H1: quotes/stream -> ticks', () => {
  it('decodes a 451- header plus a binary JSON attachment with a 0x04 prefix', () => {
    const d = new QuotexDecoder();
    const [ev] = assemble([header('quotes/stream'), { json: '[["EURUSD_otc",1792670400.123,1.07123,0],["GBPUSD",1792670400.5,1.2701,1]]', prefix04: true }]);
    expect(d.decode(ev!, 'in', NOW).events).toEqual([
      { kind: 'tick', asset: 'EURUSD_otc', isOTC: true, ts: 1792670400123, price: 1.07123 },
      { kind: 'tick', asset: 'GBPUSD', isOTC: false, ts: 1792670400500, price: 1.2701 },
    ]);
    expect(d.stats.ticks).toBe(2);
  });

  it('decodes the attachment without the prefix, a plain 42 event and a single bare row', () => {
    const d = new QuotexDecoder();
    const [a] = assemble([header('quotes/stream'), { json: '[["AUDCAD_otc",1792670401,0.9,0]]' }]);
    const [b] = assemble([{ text: '42["quotes/stream",[["AUDCAD_otc",1792670402,0.91,0]]]' }]);
    const [c] = assemble([{ text: '42["quotes/stream",["AUDCAD_otc",1792670403,0.92,0]]' }]);
    expect([a, b, c].flatMap((e) => d.decode(e!, 'in', NOW).events).map((e) => (e.kind === 'tick' ? e.ts : 0))).toEqual([
      1792670401000, 1792670402000, 1792670403000,
    ]);
  });

  it('keeps millisecond timestamps as they are', () => {
    expect(toMs(1792670400123)).toBe(1792670400123);
    expect(toMs(1792670400.1239)).toBe(1792670400124);
  });

  it('rejects malformed rows and counts them', () => {
    const d = new QuotexDecoder();
    const [ev] = assemble([{ text: '42["quotes/stream",[["A",1792670400,0,0],[1,2,3],["B","x",1],["C",1792670400,1.5]]]' }]);
    expect(d.decode(ev!, 'in', NOW).events).toHaveLength(1);
    expect(d.stats.ticksRejected).toBe(3);
    const [bad] = assemble([{ text: '42["quotes/stream",{"not":"an array"}]' }]);
    expect(d.decode(bad!, 'in', NOW).events).toEqual([]);
    expect(d.stats.badPayloads).toBe(1);
  });
});

describe('hypothesis H2: instruments/list -> payouts', () => {
  const list = (p1: number, p2: number) =>
    JSON.stringify([
      [1, 'EURUSD_otc', 'EUR/USD (OTC)', 'currency', 2, p1, 60, 30, 3, 1, 170, 0, [], 0, true],
      [2, 'GBPUSD', 'GBP/USD', 'currency', 2, p2, 60, 30, 3, 1, 170, 0, [], 0, false],
      ['junk'],
    ]);

  it('emits a payout per instrument, then only on change', () => {
    const d = new QuotexDecoder();
    const [ev] = assemble([header('instruments/list'), { json: list(85, 80), prefix04: true }]);
    expect(d.decode(ev!, 'in', NOW).events).toEqual([
      { kind: 'payout', asset: 'EURUSD_otc', isOTC: true, ts: NOW, percent: 85 },
      { kind: 'payout', asset: 'GBPUSD', isOTC: false, ts: NOW, percent: 80 },
    ]);
    expect(d.stats.payoutsRejected).toBe(1);
    const [again] = assemble([header('instruments/list'), { json: list(85, 82) }]);
    expect(d.decode(again!, 'in', NOW + 1000).events).toEqual([{ kind: 'payout', asset: 'GBPUSD', isOTC: false, ts: NOW + 1000, percent: 82 }]);
  });

  it('re-emits an unchanged payout after the refresh interval', () => {
    const d = new QuotexDecoder();
    const [ev] = assemble([{ text: `42["instruments/list",${list(85, 80)}]` }]);
    d.decode(ev!, 'in', NOW);
    expect(d.decode(ev!, 'in', NOW + 3_599_000).events).toHaveLength(0);
    expect(d.decode(ev!, 'in', NOW + 3_600_000).events).toHaveLength(2);
  });
});

describe('hypothesis H3: history -> closed feed candles only', () => {
  const T = Date.UTC(2026, 9, 22, 11, 55, 0) / 1000;
  const hist = (period: number, candles: unknown[]) => JSON.stringify({ asset: 'EURUSD_otc', period, history: [], candles }); // history ticks are covered in 'history ticks for backfill'

  it('decodes [ts, open, close, high, low] rows, drops the newest and any not yet closed', () => {
    const d = new QuotexDecoder();
    const rows = [
      [T + 60, 1.2, 1.1, 1.25, 1.05, 12],
      [T, 1.0, 1.2, 1.3, 0.9, 10],
      [T + 120, 1.1, 1.1, 1.1, 1.1, 1],
      [T + 180, 1.1, 1.15, 1.2, 1.0, 3],
    ];
    const [ev] = assemble([header('history/list/v2'), { json: hist(60, rows), prefix04: true }]);
    // NOW is 12:00:30, so T+180 (11:58) is closed but newest; T+120 (11:57) closed.
    const out = d.decode(ev!, 'in', NOW).events;
    expect(out).toEqual([
      { kind: 'candle', asset: 'EURUSD_otc', isOTC: true, tf: '1m', candle: { openTs: T * 1000, open: 1.0, high: 1.3, low: 0.9, close: 1.2, tickCount: 0 } },
      { kind: 'candle', asset: 'EURUSD_otc', isOTC: true, tf: '1m', candle: { openTs: (T + 60) * 1000, open: 1.2, high: 1.25, low: 1.05, close: 1.1, tickCount: 0 } },
      { kind: 'candle', asset: 'EURUSD_otc', isOTC: true, tf: '1m', candle: { openTs: (T + 120) * 1000, open: 1.1, high: 1.1, low: 1.1, close: 1.1, tickCount: 0 } },
    ]);
    expect(d.stats.candlesSkippedOpen).toBe(1);

    // With server time only just past T+60, the T+60 candle is still forming.
    const early = new QuotexDecoder().decode(ev!, 'in', (T + 60) * 1000 + 1000).events;
    expect(early).toHaveLength(1);
  });

  it('rejects rows whose high/low contradict the hypothesised order, and misaligned rows', () => {
    const d = new QuotexDecoder();
    // OHLC order would read high=1.0 < close: inconsistent with [ts, open, close, high, low].
    const rows = [[T, 1.1, 1.3, 1.0, 1.2], [T + 1, 1, 1, 1, 1], [T + 60, 1, 1, 1, 1], [T + 120, 1, 1, 1, 1]];
    const [ev] = assemble([{ text: `42["history/list/v2",${hist(60, rows)}]` }]);
    expect(d.decode(ev!, 'in', NOW).events).toHaveLength(1);
    expect(d.stats.candlesRejected).toBe(2);
  });

  it('ignores unknown periods and payloads without candles', () => {
    const d = new QuotexDecoder();
    const [a] = assemble([{ text: `42["history/list/v2",${hist(30, [[T, 1, 1, 1, 1]])}]` }]);
    const [b] = assemble([{ text: '42["history/load",{"asset":"X","period":60}]' }]);
    const [c] = assemble([{ text: '42["history/load",[1,2,3]]' }]);
    expect([a, b, c].flatMap((e) => d.decode(e!, 'in', NOW).events)).toEqual([]);
    expect(d.stats.historyIgnored).toBe(3);
  });
});

describe('hypothesis H4: outgoing frames name the viewed asset', () => {
  it('reads instruments/update {asset, period} and depth/follow "ASSET"', () => {
    const d = new QuotexDecoder();
    const [a] = assemble([{ text: '42["instruments/update",{"asset":"EURUSD_otc","period":60}]' }]);
    const [b] = assemble([{ text: '42["depth/follow","GBPUSD"]' }]);
    expect(d.decode(a!, 'out', NOW)).toEqual({ events: [], viewing: 'EURUSD_otc' });
    expect(d.decode(b!, 'out', NOW)).toEqual({ events: [], viewing: 'GBPUSD' });
  });

  it('never turns outgoing frames into market events', () => {
    const d = new QuotexDecoder();
    const [ev] = assemble([{ text: '42["quotes/stream",[["A",1792670400,1,0]]]' }]);
    expect(d.decode(ev!, 'out', NOW).events).toEqual([]);
  });
});

describe('hypothesis H5 and unknown events', () => {
  it('treats ids ending in _otc as OTC', () => {
    expect(isOtcAsset('EURUSD_otc')).toBe(true);
    expect(isOtcAsset('EURUSD_OTC')).toBe(true);
    expect(isOtcAsset('EURUSD')).toBe(false);
  });

  it('counts unknown event names per direction and name, and never throws', () => {
    const d = new QuotexDecoder();
    for (const t of ['42["s_balance",{"x":1}]', '42["s_balance",{}]', '42["tick"]']) d.decode(assemble([{ text: t }])[0]!, 'in', NOW);
    d.decode(assemble([{ text: '42["tick"]' }])[0]!, 'out', NOW);
    expect(Object.fromEntries(d.unknown)).toEqual({ 'in s_balance': 2, 'in tick': 1, 'out tick': 1 });
    const weird: SocketEvent = { name: 'quotes/stream', nsp: '/', ackId: null, args: [new Uint8Array([0xff])], attachments: 1 };
    expect(d.decode(weird, 'in', NOW).events).toEqual([]);
  });
});

// Shapes confirmed in the first real recording (2026-10-22); values made up.
describe('history ticks for backfill', () => {
  it('turns history/list/v2 array rows and history/load object rows into one history event each', () => {
    const d = new QuotexDecoder();
    const ev = (name: string, payload: unknown): SocketEvent => ({ name, nsp: '/', ackId: null, args: [payload], attachments: 0 });
    const list = d.decode(ev('history/list/v2', { asset: 'BRLUSD_otc', period: 15, history: [[1792669211.251, 0.19444, 1], [1792669211.037, 0.19441, 0]], candles: [] }), 'in', 1792669212000);
    expect(list.events).toEqual([{ kind: 'history', asset: 'BRLUSD_otc', isOTC: true, ts: 1792669212000, ticks: [{ ts: 1792669211037, price: 0.19441 }, { ts: 1792669211251, price: 0.19444 }] }]);
    const load = d.decode(ev('history/load', { asset: 'NZDCAD_otc', index: 1, period: 0, data: [{ asset: 'NZDCAD_otc', time: 1792666209.3, price: 0.8123, tick: 1 }, { time: 'bad', price: 1 }] }), 'in', 1792669300000);
    expect(load.events).toEqual([{ kind: 'history', asset: 'NZDCAD_otc', isOTC: true, ts: 1792669300000, ticks: [{ ts: 1792666209300, price: 0.8123 }] }]);
    expect(d.stats).toMatchObject({ historyTicks: 3, historyTicksRejected: 1, historyIgnored: 0 });
  });
});
