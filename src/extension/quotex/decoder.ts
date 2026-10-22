// Quotex decoder: assembled Socket.IO events -> MarketEvents.
//
// The schema is NOT confirmed. Everything Quotex-specific lives in QUOTEX_SCHEMA below, built from
// hypotheses taken from public open-source Quotex clients. After the phase 0 recording, run
// `npm run analyze-frames -- <raw-frames.ndjson>` and fix the table; the code below it should not
// need to change. The decoder never throws: anything that does not fit is counted and dropped.

import { TF_MS, type Candle, type MarketEvent, type Tick, type Timeframe } from '../../core/contracts';
import { attachmentJson, type SocketEvent } from './socketio';

// ---------------------------------------------------------------------------------------------
// MAPPING TABLE (hypotheses; every entry is unverified until real frames are seen)
// ---------------------------------------------------------------------------------------------
export const QUOTEX_SCHEMA = {
  /** H1: incoming tick stream, usually a 451- header plus a binary JSON attachment. */
  quotes: {
    events: ['quotes/stream'],
    /** Each row: [assetId, timestampSeconds (float), price, ...]. A single bare row is accepted too. */
    row: { asset: 0, ts: 1, price: 2 },
  },
  /** H2: incoming instrument list; one array per instrument. */
  instruments: {
    events: ['instruments/list'],
    /** pyquotex reads symbol at 1, display name at 2, payout percent at 5. */
    row: { asset: 1, name: 2, payoutPercent: 5 },
  },
  /**
   * H3: incoming chart history for an asset when it is opened. Confirmed 2026-10-22 at chart period
   * 15 s: history/list/v2 carries `history: [[tsSeconds, price, flag], ...]` (about 10 min) and
   * history/load carries `data: [{asset, time, price, tick}, ...]` (about 50 min); `candles` was empty.
   */
  history: {
    events: ['history/list/v2', 'history/load', 'history/load/line'],
    fields: { asset: 'asset', period: 'period', candles: 'candles' },
    /** Tick lists: array rows [ts, price, ...] under `history`, object rows {time, price} under `data`. */
    ticks: { arrayField: 'history', arrayRow: { ts: 0, price: 1 }, objectField: 'data', objectRow: { ts: 'time', price: 'price' } },
    /** Candle row: [openTs, open, close, high, low, ...]. Note the order: close before high/low. */
    candle: { ts: 0, open: 1, close: 2, high: 3, low: 4 },
    /** Period in seconds -> timeframe. Other periods are ignored. */
    periods: { 60: '1m', 120: '2m', 300: '5m' } as Record<number, Timeframe>,
  },
  /** H4: outgoing frames that say which asset the tab is viewing (panel only). */
  viewing: {
    /** args[0] is { asset, period } */
    objectAsset: { events: ['instruments/update'], field: 'asset' },
    /** args[0] is the asset id string */
    stringAsset: { events: ['depth/follow'] },
  },
  /** H5: OTC asset ids end in _otc. */
  otcPattern: /_otc$/i,
} as const;

// TUNABLE: values below 1e11 are taken as seconds (1e11 s is year 5138, 1e11 ms is 1973).
const SECONDS_THRESHOLD = 1e11;
// TUNABLE: re-emit an unchanged payout this often so 30-day payout retention always keeps a recent record.
const PAYOUT_REFRESH_MS = 3_600_000;

export function isOtcAsset(asset: string): boolean {
  return QUOTEX_SCHEMA.otcPattern.test(asset);
}

/** Seconds or milliseconds -> integer milliseconds. */
export function toMs(ts: number): number {
  return Math.round(ts < SECONDS_THRESHOLD ? ts * 1000 : ts);
}

export interface DecoderStats {
  ticks: number;
  ticksRejected: number;
  payouts: number;
  payoutsRejected: number;
  candles: number;
  candlesRejected: number;
  /** Candles that may still be forming (newest in a batch or not yet closed by server time). */
  candlesSkippedOpen: number;
  historyIgnored: number;
  /** Ticks taken from history payloads for backfill, and history rows that didn't parse. */
  historyTicks: number;
  historyTicksRejected: number;
  /** Known events whose payload did not have the hypothesised shape at all. */
  badPayloads: number;
}

export interface DecodeResult {
  events: MarketEvent[];
  /** Asset the tab says it is viewing, from outgoing frames. */
  viewing: string | null;
}

const NOTHING: DecodeResult = { events: [], viewing: null };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPrice = (v: unknown): v is number => isNum(v) && v > 0;
const isAsset = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64;

/** First argument of an event as JSON: binary attachments and JSON strings are unwrapped. */
export function payloadOf(ev: SocketEvent): unknown {
  const a = ev.args[0];
  if (a instanceof Uint8Array) return attachmentJson(a);
  if (typeof a === 'string' && /^\s*[[{]/.test(a)) {
    try {
      return JSON.parse(a);
    } catch {
      return a;
    }
  }
  return a;
}

export class QuotexDecoder {
  readonly stats: DecoderStats = {
    ticks: 0, ticksRejected: 0, payouts: 0, payoutsRejected: 0, candles: 0, candlesRejected: 0,
    candlesSkippedOpen: 0, historyIgnored: 0, historyTicks: 0, historyTicksRejected: 0, badPayloads: 0,
  };
  /** Event names not in the mapping table, keyed "in name" / "out name". */
  readonly unknown = new Map<string, number>();
  /** Quotex's display name per asset id, e.g. BRLUSD_otc -> "USD/BRL (OTC)". The id is Quotex's own code. */
  readonly names = new Map<string, string>();
  private readonly lastPayout = new Map<string, { percent: number; ts: number }>();

  /** `serverNow` is the best current estimate of server time (local clock + offset). */
  decode(ev: SocketEvent, dir: 'in' | 'out', serverNow: number): DecodeResult {
    try {
      return this.decodeUnsafe(ev, dir, serverNow);
    } catch {
      this.stats.badPayloads++;
      return NOTHING;
    }
  }

  private decodeUnsafe(ev: SocketEvent, dir: 'in' | 'out', serverNow: number): DecodeResult {
    const S = QUOTEX_SCHEMA;
    const has = (list: readonly string[]) => list.includes(ev.name);
    if (dir === 'out') {
      if (has(S.viewing.objectAsset.events)) {
        const p = payloadOf(ev) as Record<string, unknown> | null;
        const asset = p && typeof p === 'object' ? p[S.viewing.objectAsset.field] : undefined;
        return isAsset(asset) ? { events: [], viewing: asset } : this.bad();
      }
      if (has(S.viewing.stringAsset.events)) {
        const asset = payloadOf(ev);
        return isAsset(asset) ? { events: [], viewing: asset } : this.bad();
      }
    } else {
      if (has(S.quotes.events)) return { events: this.quotes(payloadOf(ev)), viewing: null };
      if (has(S.instruments.events)) return { events: this.instruments(payloadOf(ev), serverNow), viewing: null };
      if (has(S.history.events)) return { events: this.history(payloadOf(ev), serverNow), viewing: null };
    }
    const key = `${dir} ${ev.name}`;
    this.unknown.set(key, (this.unknown.get(key) ?? 0) + 1);
    return NOTHING;
  }

  private bad(): DecodeResult {
    this.stats.badPayloads++;
    return NOTHING;
  }

  private quotes(payload: unknown): MarketEvent[] {
    if (!Array.isArray(payload)) {
      this.stats.badPayloads++;
      return [];
    }
    const { row } = QUOTEX_SCHEMA.quotes;
    const rows: unknown[] = isAsset(payload[row.asset]) ? [payload] : payload;
    const out: MarketEvent[] = [];
    for (const r of rows) {
      const asset = Array.isArray(r) ? r[row.asset] : undefined;
      const ts = Array.isArray(r) ? r[row.ts] : undefined;
      const price = Array.isArray(r) ? r[row.price] : undefined;
      if (!isAsset(asset) || !isNum(ts) || ts <= 0 || !isPrice(price)) {
        this.stats.ticksRejected++;
        continue;
      }
      out.push({ kind: 'tick', asset, isOTC: isOtcAsset(asset), ts: toMs(ts), price });
    }
    this.stats.ticks += out.length;
    return out;
  }

  private instruments(payload: unknown, serverNow: number): MarketEvent[] {
    if (!Array.isArray(payload)) {
      this.stats.badPayloads++;
      return [];
    }
    const { row } = QUOTEX_SCHEMA.instruments;
    const out: MarketEvent[] = [];
    for (const r of payload) {
      const asset = Array.isArray(r) ? r[row.asset] : undefined;
      const percent = Array.isArray(r) ? r[row.payoutPercent] : undefined;
      const name = Array.isArray(r) ? r[row.name] : undefined;
      if (isAsset(asset) && typeof name === 'string' && name.length > 0 && name.length <= 64) this.names.set(asset, name);
      if (!isAsset(asset) || !isNum(percent) || percent < 0 || percent > 100) {
        this.stats.payoutsRejected++;
        continue;
      }
      const last = this.lastPayout.get(asset);
      if (last && last.percent === percent && serverNow - last.ts < PAYOUT_REFRESH_MS) continue;
      this.lastPayout.set(asset, { percent, ts: serverNow });
      out.push({ kind: 'payout', asset, isOTC: isOtcAsset(asset), ts: serverNow, percent });
    }
    this.stats.payouts += out.length;
    return out;
  }

  private history(payload: unknown, serverNow: number): MarketEvent[] {
    const H = QUOTEX_SCHEMA.history;
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      this.stats.historyIgnored++;
      return [];
    }
    const p = payload as Record<string, unknown>;
    const asset = p[H.fields.asset];
    const ticks = isAsset(asset) ? this.historyTicks(p) : [];
    const backfill: MarketEvent[] = ticks.length ? [{ kind: 'history', asset: asset as string, isOTC: isOtcAsset(asset as string), ts: serverNow, ticks }] : [];
    this.stats.historyTicks += ticks.length;
    const period = p[H.fields.period];
    const rows = p[H.fields.candles];
    const tf = isNum(period) ? H.periods[period] : undefined;
    if (!isAsset(asset) || !tf || !Array.isArray(rows)) {
      if (backfill.length === 0) this.stats.historyIgnored++;
      return backfill;
    }
    const tfMs = TF_MS[tf];
    const parsed: Candle[] = [];
    for (const r of rows) {
      const c = Array.isArray(r) ? this.candleRow(r, tfMs) : null;
      if (c) parsed.push(c);
      else this.stats.candlesRejected++;
    }
    if (parsed.length === 0) return backfill;
    // The newest candle of a history batch is usually the one still forming; a 'feed' candle can
    // never be replaced by a rebuilt one, so a partial candle must not get in.
    const newest = Math.max(...parsed.map((c) => c.openTs));
    const isOTC = isOtcAsset(asset);
    const out: MarketEvent[] = [];
    for (const candle of parsed) {
      if (candle.openTs === newest || candle.openTs + tfMs > serverNow) {
        this.stats.candlesSkippedOpen++;
        continue;
      }
      out.push({ kind: 'candle', asset, isOTC, tf, candle });
    }
    out.sort((a, b) => (a.kind === 'candle' && b.kind === 'candle' ? a.candle.openTs - b.candle.openTs : 0));
    this.stats.candles += out.length;
    return [...backfill, ...out];
  }

  /** Valid history ticks of one payload, oldest first. Rows that don't parse are counted and skipped. */
  private historyTicks(p: Record<string, unknown>): Tick[] {
    const T = QUOTEX_SCHEMA.history.ticks;
    const out: Tick[] = [];
    const add = (ts: unknown, price: unknown) => {
      if (isNum(ts) && ts > 0 && isPrice(price)) out.push({ ts: toMs(ts), price });
      else this.stats.historyTicksRejected++;
    };
    const arr = p[T.arrayField];
    if (Array.isArray(arr)) for (const r of arr) Array.isArray(r) ? add(r[T.arrayRow.ts], r[T.arrayRow.price]) : this.stats.historyTicksRejected++;
    const obj = p[T.objectField];
    if (Array.isArray(obj)) {
      for (const r of obj) {
        const o = typeof r === 'object' && r !== null ? (r as Record<string, unknown>) : null;
        if (o) add(o[T.objectRow.ts], o[T.objectRow.price]);
        else this.stats.historyTicksRejected++;
      }
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  private candleRow(r: unknown[], tfMs: number): Candle | null {
    const m = QUOTEX_SCHEMA.history.candle;
    const [ts, open, close, high, low] = [r[m.ts], r[m.open], r[m.close], r[m.high], r[m.low]];
    if (!isNum(ts) || !isPrice(open) || !isPrice(close) || !isPrice(high) || !isPrice(low)) return null;
    const openTs = toMs(ts);
    // A wrong field order shows up as highs below the body or lows above it.
    if (high < Math.max(open, close) || low > Math.min(open, close) || openTs % tfMs !== 0) return null;
    return { openTs, open, high, low, close, tickCount: 0 };
  }
}
