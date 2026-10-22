// Offline analysis of exported raw frames (NDJSON of RawFrameRecord), for mapping the Quotex
// schema after the phase 0 recording. Used by scripts/analyze-frames.ts.
//
// It reports what is actually in the frames, independent of the decoder's hypotheses (event names,
// payload shapes, asset-like strings, timestamp-like numbers, candle field order), and separately
// what the current decoder makes of them (decoded ticks per asset, rejects, unknown names).

import { TF_MS, type DatasetMeta, type MarketEvent, type RawFrameRecord, type SourceAsset } from '../../core/contracts';
import { OffsetEstimator, median } from '../background/clock';
import { TickGate } from '../background/dedupe';
import { isOtcAsset, QuotexDecoder, type DecoderStats } from '../quotex/decoder';
import { attachmentJson, BinaryAssembler, parseFrame, type SocketEvent } from '../quotex/socketio';

const MAX_WALK = 2_000; // TUNABLE: values inspected per payload when scanning for timestamps and asset ids
const OFFSET_SAMPLES = 200; // TUNABLE: timestamp samples kept per event name for the offset guess
const SAMPLE_CHARS = 240;
const ASSET_LIKE = /^#?[A-Z][A-Z0-9]{2,11}(_otc)?$/;

interface EventInfo {
  dir: 'in' | 'out';
  name: string;
  count: number;
  withAttachments: number;
  shapes: Map<string, number>;
  sample: string;
  ts: { seconds: number; secondsFractional: number; millis: number; micros: number; offsetsMs: number[] };
}

interface TickInfo {
  count: number;
  duplicates: number;
  late: number;
  firstTs: number;
  lastTs: number;
}

export interface EventReport {
  dir: 'in' | 'out';
  name: string;
  count: number;
  withAttachments: number;
  shape: string;
  otherShapes: number;
  sample: string;
  timestamps: { seconds: number; secondsFractional: number; millis: number; micros: number; medianOffsetVsLocalMs: number | null; guess: string };
}

export interface AnalysisReport {
  lines: number;
  badLines: number;
  frames: number;
  byDir: { in: number; out: number };
  byEncoding: { text: number; base64: number };
  tabs: number[];
  socketUrls: string[];
  firstReceivedAt: number | null;
  lastReceivedAt: number | null;
  packets: Record<string, number>;
  unknownPackets: Record<string, number>;
  orphanBinaries: number;
  incompleteHeaders: number;
  events: EventReport[];
  assetLike: { value: string; count: number }[];
  candleRows: { rows: number; tOpenCloseHighLow: number; tOpenHighLowClose: number };
  decoder: { stats: DecoderStats; unknown: Record<string, number>; ticks: { asset: string; isOTC: boolean; count: number; duplicates: number; late: number; perMinute: number | null; firstTs: number; lastTs: number }[] };
}

/** A compact description of a JSON value's structure. */
export function shapeOf(v: unknown, depth = 0): string {
  if (v === null) return 'null';
  if (v instanceof Uint8Array) return `binary(${v.length} bytes, not JSON)`;
  switch (typeof v) {
    case 'string':
      return 'string';
    case 'number':
      return Number.isInteger(v) ? 'int' : 'float';
    case 'boolean':
      return 'bool';
    case 'object':
      break;
    default:
      return typeof v;
  }
  if (depth >= 4) return Array.isArray(v) ? '[…]' : '{…}';
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    const shapes = v.slice(0, 50).map((x) => shapeOf(x, depth + 1));
    const uniq = [...new Set(shapes)];
    if (uniq.length === 1 && v.length > 1) return `[${uniq[0]} ×${v.length}]`;
    if (v.length <= 8) return `[${shapes.join(', ')}]`;
    return `[mixed ×${v.length}: ${uniq.slice(0, 4).join(' | ')}${uniq.length > 4 ? ' | …' : ''}]`;
  }
  const entries = Object.entries(v as Record<string, unknown>);
  const shown = entries.slice(0, 20).map(([k, x]) => `${k}: ${shapeOf(x, depth + 1)}`);
  return `{${shown.join(', ')}${entries.length > 20 ? `, …+${entries.length - 20}` : ''}}`;
}

function unwrap(v: unknown): unknown {
  if (v instanceof Uint8Array) {
    const j = attachmentJson(v);
    return j === undefined ? v : j;
  }
  return v;
}

function walk(v: unknown, visit: (x: unknown, parent: unknown[] | null) => void): void {
  let budget = MAX_WALK;
  const go = (x: unknown, parent: unknown[] | null, depth: number) => {
    if (budget-- <= 0 || depth > 8) return;
    visit(x, parent);
    if (Array.isArray(x)) for (const y of x) go(y, x, depth + 1);
    else if (typeof x === 'object' && x !== null && !(x instanceof Uint8Array)) for (const y of Object.values(x)) go(y, null, depth + 1);
  };
  go(v, null, 0);
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

function tsClass(x: number): 'seconds' | 'millis' | 'micros' | null {
  if (x >= 1e9 && x < 2e10) return 'seconds';
  if (x >= 1e12 && x < 2e13) return 'millis';
  if (x >= 1e15 && x < 2e16) return 'micros';
  return null;
}

function isRawFrame(x: unknown): x is RawFrameRecord {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return (r.dir === 'in' || r.dir === 'out') && (r.encoding === 'text' || r.encoding === 'base64') && typeof r.data === 'string' && typeof r.receivedAt === 'number';
}

export class FrameAnalyzer {
  private lines = 0;
  private badLines = 0;
  private frames = 0;
  private readonly byDir = { in: 0, out: 0 };
  private readonly byEncoding = { text: 0, base64: 0 };
  private readonly tabs = new Set<number>();
  private readonly urls = new Set<string>();
  private firstAt: number | null = null;
  private lastAt: number | null = null;
  private readonly packets = new Map<string, number>();
  private readonly unknownPackets = new Map<string, number>();
  private readonly sockets = new Map<string, BinaryAssembler>();
  private readonly events = new Map<string, EventInfo>();
  private readonly assetLike = new Map<string, number>();
  private readonly candleRows = { rows: 0, tOpenCloseHighLow: 0, tOpenHighLowClose: 0 };
  private readonly decoder = new QuotexDecoder();
  private readonly offset = new OffsetEstimator();
  private readonly gate = new TickGate();
  private readonly ticks = new Map<string, TickInfo>();
  private readonly dataset: MarketEvent[] | null;
  private readonly latestPayout = new Map<string, number>();

  constructor(opts: { collectDataset?: boolean } = {}) {
    this.dataset = opts.collectDataset ? [] : null;
  }

  addLine(line: string): void {
    const t = line.trim();
    if (t.length === 0) return;
    this.lines++;
    let rec: unknown;
    try {
      rec = JSON.parse(t);
    } catch {
      this.badLines++;
      return;
    }
    if (!isRawFrame(rec)) {
      this.badLines++;
      return;
    }
    this.add(rec);
  }

  add(rec: RawFrameRecord): void {
    this.frames++;
    this.byDir[rec.dir]++;
    this.byEncoding[rec.encoding]++;
    this.tabs.add(rec.tabId);
    this.urls.add(rec.socketUrl);
    this.firstAt = this.firstAt === null ? rec.receivedAt : Math.min(this.firstAt, rec.receivedAt);
    this.lastAt = this.lastAt === null ? rec.receivedAt : Math.max(this.lastAt, rec.receivedAt);

    const pkt = parseFrame({ encoding: rec.encoding, data: rec.data });
    this.bump(this.packets, pkt.type);
    if (pkt.type === 'unknown') this.bump(this.unknownPackets, pkt.reason);
    const key = `${rec.tabId}|${rec.socketUrl}`;
    let asm = this.sockets.get(key);
    if (!asm) {
      asm = new BinaryAssembler();
      this.sockets.set(key, asm);
    }
    const ev = asm.push(pkt);
    if (ev) this.observe(ev, rec);
  }

  private bump(m: Map<string, number>, k: string, by = 1): void {
    m.set(k, (m.get(k) ?? 0) + by);
  }

  private observe(ev: SocketEvent, rec: RawFrameRecord): void {
    const key = `${rec.dir} ${ev.name}`;
    let info = this.events.get(key);
    const args = ev.args.map(unwrap);
    const payload = args.length === 1 ? args[0] : args;
    const shape = args.length === 0 ? '(no args)' : args.length === 1 ? shapeOf(payload) : `args(${args.map((a) => shapeOf(a)).join(', ')})`;
    if (!info) {
      let sample = '';
      try {
        sample = JSON.stringify(payload, (_k, v: unknown) => (v instanceof Uint8Array ? `<binary ${v.length} bytes>` : v)) ?? '';
      } catch {
        sample = '<unserialisable>';
      }
      info = {
        dir: rec.dir, name: ev.name, count: 0, withAttachments: 0, shapes: new Map(), sample: sample.slice(0, SAMPLE_CHARS),
        ts: { seconds: 0, secondsFractional: 0, millis: 0, micros: 0, offsetsMs: [] },
      };
      this.events.set(key, info);
    }
    info.count++;
    if (ev.attachments > 0) info.withAttachments++;
    if (info.shapes.size < 20 || info.shapes.has(shape)) this.bump(info.shapes, shape);

    const ts = info.ts;
    walk(payload, (x, parent) => {
      if (typeof x === 'string' && ASSET_LIKE.test(x)) this.bump(this.assetLike, x);
      if (isNum(x)) {
        const c = tsClass(x);
        if (c === 'seconds') {
          ts.seconds++;
          if (!Number.isInteger(x)) ts.secondsFractional++;
        } else if (c === 'millis') ts.millis++;
        else if (c === 'micros') ts.micros++;
        if ((c === 'seconds' || c === 'millis') && ts.offsetsMs.length < OFFSET_SAMPLES) ts.offsetsMs.push((c === 'seconds' ? x * 1000 : x) - rec.receivedAt);
      }
      if (rec.dir === 'in' && Array.isArray(x) && parent !== null && x.length >= 5 && x.length <= 8) this.candleRow(x);
    });

    const serverNow = rec.receivedAt + (this.offset.offset() ?? 0);
    const res = this.decoder.decode(ev, rec.dir, serverNow);
    for (const me of res.events) {
      if (me.kind === 'tick') {
        this.offset.add(me.ts, rec.receivedAt);
        let t = this.ticks.get(me.asset);
        if (!t) {
          t = { count: 0, duplicates: 0, late: 0, firstTs: me.ts, lastTs: me.ts };
          this.ticks.set(me.asset, t);
        }
        const verdict = this.gate.accept(me.asset, me.ts);
        if (verdict === 'duplicate') {
          t.duplicates++;
          continue;
        }
        if (verdict === 'stale') {
          t.late++;
          continue;
        }
        t.count++;
        t.firstTs = Math.min(t.firstTs, me.ts);
        t.lastTs = Math.max(t.lastTs, me.ts);
      }
      if (me.kind === 'payout') this.latestPayout.set(me.asset, me.percent);
      this.dataset?.push(me);
    }
  }

  private candleRow(a: unknown[]): void {
    const [t, b, c, d, e] = a;
    if (!isNum(t) || tsClass(t) === null || ![b, c, d, e].every((x) => isNum(x) && x > 0)) return;
    const [p1, p2, p3, p4] = [b, c, d, e] as [number, number, number, number];
    this.candleRows.rows++;
    if (p3 >= Math.max(p1, p2) && p4 <= Math.min(p1, p2)) this.candleRows.tOpenCloseHighLow++;
    if (p2 >= Math.max(p1, p4) && p3 <= Math.min(p1, p4)) this.candleRows.tOpenHighLowClose++;
  }

  report(): AnalysisReport {
    const events: EventReport[] = [...this.events.values()]
      .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1))
      .map((e) => {
        const shapes = [...e.shapes.entries()].sort((a, b) => b[1] - a[1]);
        const t = e.ts;
        const med = t.offsetsMs.length ? median(t.offsetsMs) : null;
        let guess = 'no timestamp-like numbers';
        if (t.seconds + t.millis + t.micros > 0) {
          const unit = t.seconds >= t.millis && t.seconds >= t.micros ? 'seconds' : t.millis >= t.micros ? 'milliseconds' : 'microseconds';
          const frac = unit === 'seconds' && t.secondsFractional > 0 ? ' (fractional, sub-second precision)' : '';
          guess = `${unit}${frac}`;
        }
        return {
          dir: e.dir, name: e.name, count: e.count, withAttachments: e.withAttachments,
          shape: shapes[0]?.[0] ?? '', otherShapes: Math.max(0, shapes.length - 1), sample: e.sample,
          timestamps: { seconds: t.seconds, secondsFractional: t.secondsFractional, millis: t.millis, micros: t.micros, medianOffsetVsLocalMs: med, guess },
        };
      });
    let orphanBinaries = 0;
    let incompleteHeaders = 0;
    for (const a of this.sockets.values()) {
      orphanBinaries += a.orphanBinaries;
      incompleteHeaders += a.incompleteHeaders;
    }
    return {
      lines: this.lines,
      badLines: this.badLines,
      frames: this.frames,
      byDir: { ...this.byDir },
      byEncoding: { ...this.byEncoding },
      tabs: [...this.tabs].sort((a, b) => a - b),
      socketUrls: [...this.urls].sort(),
      firstReceivedAt: this.firstAt,
      lastReceivedAt: this.lastAt,
      packets: Object.fromEntries(this.packets),
      unknownPackets: Object.fromEntries(this.unknownPackets),
      orphanBinaries,
      incompleteHeaders,
      events,
      assetLike: [...this.assetLike.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1)),
      candleRows: { ...this.candleRows },
      decoder: {
        stats: { ...this.decoder.stats },
        unknown: Object.fromEntries(this.decoder.unknown),
        ticks: [...this.ticks.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([asset, t]) => ({
          asset,
          isOTC: isOtcAsset(asset),
          count: t.count,
          duplicates: t.duplicates,
          late: t.late,
          perMinute: t.lastTs > t.firstTs ? (t.count - 1) / ((t.lastTs - t.firstTs) / 60_000) : null,
          firstTs: t.firstTs,
          lastTs: t.lastTs,
        })),
      },
    };
  }

  /** bbqx-dataset lines decoded with the current mapping: meta, then events ordered like the export page. */
  datasetLines(createdAt: number, note = 'Decoded offline from raw frames by scripts/analyze-frames.ts with the decoder mapping of this build.'): string[] {
    const evs = this.dataset ?? [];
    const order = (e: MarketEvent) => (e.kind === 'tick' ? 0 : e.kind === 'candle' ? 1 : 2);
    const at = (e: MarketEvent) => (e.kind === 'candle' ? e.candle.openTs + TF_MS[e.tf] : e.ts);
    const name = (e: MarketEvent) => (e.kind === 'clock' ? '' : e.asset);
    const tf = (e: MarketEvent) => (e.kind === 'candle' ? e.tf : '');
    // A candle can be reported more than once (history reloads); keep the last report per key.
    const candles = new Map<string, number>();
    evs.forEach((e, i) => e.kind === 'candle' && candles.set(`${e.asset}|${e.tf}|${e.candle.openTs}`, i));
    const kept = evs.filter((e, i) => e.kind !== 'candle' || candles.get(`${e.asset}|${e.tf}|${e.candle.openTs}`) === i);
    kept.sort((a, b) => at(a) - at(b) || order(a) - order(b) || (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0) || (tf(a) < tf(b) ? -1 : tf(a) > tf(b) ? 1 : 0));
    const assets = [...new Set(kept.filter((e) => e.kind === 'tick' || e.kind === 'candle').map(name))].sort();
    const sourceAssets: SourceAsset[] = assets.map((asset) => ({ asset, isOTC: isOtcAsset(asset), payoutPercent: this.latestPayout.get(asset) ?? 0 }));
    const assetSet = new Set(assets);
    const meta: DatasetMeta = { format: 'bbqx-dataset', version: 1, createdAt, assets: sourceAssets, note };
    return [JSON.stringify(meta), ...kept.filter((e) => e.kind !== 'payout' || assetSet.has(e.asset)).map((e) => JSON.stringify(e))];
  }
}

const iso = (ts: number | null) => (ts === null ? '—' : new Date(ts).toISOString());

export function formatReport(r: AnalysisReport, maxEvents = 60): string {
  const out: string[] = [];
  const p = (s = '') => out.push(s);
  const span = r.firstReceivedAt !== null && r.lastReceivedAt !== null ? (r.lastReceivedAt - r.firstReceivedAt) / 60_000 : 0;
  p('== Frames ==');
  p(`lines ${r.lines} (unreadable ${r.badLines}) · frames ${r.frames} · in ${r.byDir.in} / out ${r.byDir.out} · text ${r.byEncoding.text} / binary ${r.byEncoding.base64}`);
  p(`received ${iso(r.firstReceivedAt)} .. ${iso(r.lastReceivedAt)} (${span.toFixed(1)} min, local clock) · tabs ${r.tabs.join(', ') || '—'}`);
  for (const u of r.socketUrls) p(`socket ${u}`);
  p(`packets: ${Object.entries(r.packets).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (Object.keys(r.unknownPackets).length) p(`unparsed: ${Object.entries(r.unknownPackets).map(([k, v]) => `${k} ×${v}`).join(', ')}`);
  p(`binary pairing: orphan attachments ${r.orphanBinaries}, headers missing attachments ${r.incompleteHeaders}`);
  p();
  p('== Event names (direction, count, payload shape, timestamp guess) ==');
  for (const e of r.events.slice(0, maxEvents)) {
    const att = e.withAttachments ? ` (${e.withAttachments} with binary attachments)` : '';
    p(`${e.dir.padEnd(3)} ${e.name}  ×${e.count}${att}`);
    p(`    shape: ${e.shape}${e.otherShapes ? `  (+${e.otherShapes} other shapes)` : ''}`);
    const t = e.timestamps;
    if (t.seconds + t.millis + t.micros > 0) {
      const off = t.medianOffsetVsLocalMs === null ? '' : `; median ts minus local receive ${(t.medianOffsetVsLocalMs / 1000).toFixed(1)} s`;
      p(`    timestamps: ${t.guess} [s ${t.seconds}, ms ${t.millis}, µs ${t.micros}]${off}`);
    }
    p(`    sample: ${e.sample}`);
  }
  if (r.events.length > maxEvents) p(`… ${r.events.length - maxEvents} more event names`);
  p();
  p('== Asset-like strings in payloads ==');
  p(r.assetLike.length ? r.assetLike.slice(0, 40).map((a) => `${a.value} ×${a.count}`).join(', ') : 'none');
  p();
  p('== Candle-like rows [ts, p, p, p, p, ...] ==');
  const c = r.candleRows;
  if (c.rows === 0) p('none found');
  else {
    const pct = (n: number) => `${((100 * n) / c.rows).toFixed(1)}%`;
    p(`rows ${c.rows}: consistent with [ts, open, close, high, low] ${pct(c.tOpenCloseHighLow)}, with [ts, open, high, low, close] ${pct(c.tOpenHighLowClose)}`);
  }
  p();
  p('== Current decoder mapping (hypotheses in src/extension/quotex/decoder.ts) ==');
  const s = r.decoder.stats;
  p(`ticks ${s.ticks} (rejected ${s.ticksRejected}) · payouts ${s.payouts} (rejected ${s.payoutsRejected}) · candles ${s.candles} (rejected ${s.candlesRejected}, skipped as open ${s.candlesSkippedOpen}) · history ignored ${s.historyIgnored} · bad payloads ${s.badPayloads}`);
  if (r.decoder.ticks.length === 0) p('no ticks decoded: the quotes hypothesis does not match these frames');
  for (const t of r.decoder.ticks) {
    const rate = t.perMinute === null ? '—' : `${t.perMinute.toFixed(1)}/min`;
    p(`${t.asset.padEnd(16)} ${t.isOTC ? 'OTC ' : 'live'}  ticks ${t.count} (dup ${t.duplicates}, late ${t.late})  rate ${rate}  ${iso(t.firstTs)} .. ${iso(t.lastTs)}`);
  }
  const unknown = Object.entries(r.decoder.unknown).sort((a, b) => b[1] - a[1]);
  p(`unknown to the decoder: ${unknown.length ? unknown.map(([k, v]) => `${k} ×${v}`).join(', ') : 'none'}`);
  return out.join('\n');
}
