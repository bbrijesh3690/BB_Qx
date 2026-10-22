// Data sources for the harness: synthetic generators and recorded bbqx-dataset NDJSON files.

import type { Candle, DataSource, DatasetMeta, MarketEvent, SourceAsset, Timeframe } from '../core/contracts';
import { utcDayOf } from '../core/time';
import { sourceAssets, syntheticEvents, type PriceModel, type SyntheticOptions } from './generators';

/** A synthetic feed: the model and options fix everything but the seed. */
export function syntheticSource(model: PriceModel, opts: SyntheticOptions): DataSource {
  return {
    id: `synthetic:${model.id}`,
    assets: sourceAssets(opts),
    events: (seed: number) => syntheticEvents(model, seed, opts),
  };
}

// ---------------------------------------------------------------------------
// Recorded datasets (contracts: line 1 is a DatasetMeta, then one MarketEvent per line, by ts)
// ---------------------------------------------------------------------------

export function toNdjson(meta: DatasetMeta, events: Iterable<MarketEvent>): string {
  const lines = [JSON.stringify(meta)];
  for (const e of events) lines.push(JSON.stringify(e));
  return lines.join('\n') + '\n';
}

/** Serialises a source for one seed, e.g. a synthetic day to replay later as a recorded dataset. */
export function datasetOf(source: DataSource, seed: number, note?: string): string {
  const events = [...source.events(seed)];
  const first = events.find((e) => e.kind !== 'candle');
  const meta: DatasetMeta = {
    format: 'bbqx-dataset', version: 1,
    createdAt: first ? first.ts : 0,
    assets: source.assets.map((a) => ({ ...a })),
    ...(note !== undefined ? { note } : {}),
  };
  return toNdjson(meta, events);
}

/** Replays a bbqx-dataset file. The seed is ignored: a recording is what it is. */
export function recordedSource(ndjsonText: string): DataSource {
  const lines = ndjsonText.split(/\r?\n/);
  let lineNo = 0;
  let meta: DatasetMeta | null = null;
  const events: MarketEvent[] = [];
  for (const raw of lines) {
    lineNo++;
    if (raw.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(`dataset line ${lineNo}: not JSON`);
    }
    if (!meta) meta = parseMeta(value, lineNo);
    else events.push(Object.freeze(parseEvent(value, lineNo)));
  }
  if (!meta) throw new Error('dataset: empty file');
  const first = events.find((e) => e.kind !== 'candle');
  const day = utcDayOf(first ? first.ts : meta.createdAt);
  const assets = meta.assets;
  return { id: `recorded:${day}`, assets, events: () => events };
}

const TFS = new Set<Timeframe>(['1m', '2m', '5m']);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function parseMeta(v: unknown, line: number): DatasetMeta {
  if (!isObj(v) || v.format !== 'bbqx-dataset' || v.version !== 1 || !isNum(v.createdAt) || !Array.isArray(v.assets))
    throw new Error(`dataset line ${line}: expected a bbqx-dataset version 1 header`);
  const assets: SourceAsset[] = v.assets.map((a, i) => {
    if (!isObj(a) || !isStr(a.asset) || typeof a.isOTC !== 'boolean' || !isNum(a.payoutPercent))
      throw new Error(`dataset line ${line}: asset ${i} is malformed`);
    return { asset: a.asset, isOTC: a.isOTC, payoutPercent: a.payoutPercent };
  });
  return { format: 'bbqx-dataset', version: 1, createdAt: v.createdAt, assets, ...(typeof v.note === 'string' ? { note: v.note } : {}) };
}

function parseCandle(v: unknown, line: number): Candle {
  if (!isObj(v) || ![v.openTs, v.open, v.high, v.low, v.close, v.tickCount].every(isNum))
    throw new Error(`dataset line ${line}: malformed candle`);
  return Object.freeze({ openTs: v.openTs as number, open: v.open as number, high: v.high as number, low: v.low as number, close: v.close as number, tickCount: v.tickCount as number });
}

function parseEvent(v: unknown, line: number): MarketEvent {
  if (!isObj(v)) throw new Error(`dataset line ${line}: not an event object`);
  const bad = (what: string) => new Error(`dataset line ${line}: ${String(v.kind)} event has a bad ${what}`);
  switch (v.kind) {
    case 'tick':
      if (!isStr(v.asset)) throw bad('asset');
      if (typeof v.isOTC !== 'boolean') throw bad('isOTC');
      if (!isNum(v.ts)) throw bad('ts');
      if (!isNum(v.price)) throw bad('price');
      return { kind: 'tick', asset: v.asset, isOTC: v.isOTC, ts: v.ts, price: v.price };
    case 'payout':
      if (!isStr(v.asset)) throw bad('asset');
      if (typeof v.isOTC !== 'boolean') throw bad('isOTC');
      if (!isNum(v.ts)) throw bad('ts');
      if (!isNum(v.percent)) throw bad('percent');
      return { kind: 'payout', asset: v.asset, isOTC: v.isOTC, ts: v.ts, percent: v.percent };
    case 'candle':
      if (!isStr(v.asset)) throw bad('asset');
      if (typeof v.isOTC !== 'boolean') throw bad('isOTC');
      if (!TFS.has(v.tf as Timeframe)) throw bad('tf');
      return { kind: 'candle', asset: v.asset, isOTC: v.isOTC, tf: v.tf as Timeframe, candle: parseCandle(v.candle, line) };
    case 'clock':
      if (!isNum(v.ts)) throw bad('ts');
      return { kind: 'clock', ts: v.ts };
    default:
      throw new Error(`dataset line ${line}: unknown event kind ${JSON.stringify(v.kind)}`);
  }
}
