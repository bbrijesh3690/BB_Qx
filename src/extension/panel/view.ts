// Pure formatting for the panel, kept apart from the DOM code so it can be tested in Node.

import type { CandleRow, PanelSnapshot, RecorderView } from '../shared/messages';

export const FEED_DEAD_MS = 10_000; // the brief: the "feed alive" dot turns red after 10 s without a tick

export type Dot = 'green' | 'red' | 'grey';
export type CandleColour = 'green' | 'red' | 'doji';

export function aliveDot(ageMs: number | null): Dot {
  if (ageMs === null) return 'grey';
  return ageMs > FEED_DEAD_MS ? 'red' : 'green';
}

export function ageText(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return durationText(ms);
}

export function durationText(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  if (h < 48) return `${h}h ${m}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function candleColour(c: Pick<CandleRow, 'open' | 'close'>): CandleColour {
  return c.close > c.open ? 'green' : c.close < c.open ? 'red' : 'doji';
}

/** "2026-10-22 14:05" in UTC. */
export function utcMinute(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
}

function decimalsOf(x: number): number {
  const s = String(x);
  if (s.includes('e')) return 6;
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/** One decimal count for a whole candle list, so columns line up like the chart's price scale. */
export function priceDecimals(rows: readonly CandleRow[]): number {
  let d = 0;
  for (const r of rows) d = Math.max(d, decimalsOf(r.open), decimalsOf(r.high), decimalsOf(r.low), decimalsOf(r.close));
  return Math.min(6, d);
}

export function int(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function mbText(mb: number): string {
  return mb < 10 ? `${mb.toFixed(2)} MB` : `${Math.round(mb).toLocaleString('en-US')} MB`;
}

export function recorderText(r: RecorderView): string {
  if (r.on) {
    const left = r.timeLeftMs === null ? '' : ` · ${durationText(r.timeLeftMs)} left`;
    return `ON · ${int(r.framesThisRun)} / ${int(r.frameCap)} frames this run${left}`;
  }
  const why = r.stoppedReason === 'time' ? 'stopped after 24 h' : r.stoppedReason === 'cap' ? 'stopped at frame cap' : 'stopped';
  return `OFF (${why})`;
}

export function storedText(r: RecorderView): string {
  return `${int(r.framesStored)} frames stored · ~${mbText(r.approxMB)}`;
}

/** Overall feed state for the header dot: any asset alive -> green, frames but no live asset -> red. */
export function headerDot(s: PanelSnapshot | null): Dot {
  if (!s || (s.framesSeen === 0 && s.assets.length === 0)) return 'grey';
  return s.assets.some((a) => aliveDot(a.lastTickAgeMs) === 'green') ? 'green' : 'red';
}

/** Default asset for the spot-check list: what this tab views, else what it feeds, else the first. */
export function defaultSpotAsset(s: PanelSnapshot, current: string | null): string | null {
  const names = s.assets.map((a) => a.asset);
  if (current && names.includes(current)) return current;
  const self = s.tabs.find((t) => t.tabId === s.selfTabId);
  if (self?.viewing && names.includes(self.viewing)) return self.viewing;
  const fed = self?.assets.find((a) => names.includes(a));
  return fed ?? names[0] ?? null;
}

export function unknownSummary(s: PanelSnapshot, top = 5): string {
  const total = s.unknownEvents.reduce((n, u) => n + u.count, 0);
  if (s.unknownEvents.length === 0) return 'none';
  const head = s.unknownEvents.slice(0, top).map((u) => `${u.name} ×${int(u.count)}`).join(', ');
  const more = s.unknownEvents.length > top ? `, +${s.unknownEvents.length - top} more` : '';
  return `${s.unknownEvents.length} names, ${int(total)} frames: ${head}${more}`;
}
