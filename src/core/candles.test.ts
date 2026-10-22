import { describe, expect, it } from 'vitest';
import { CandleBuilder, type BuilderEffect } from './candles';

const T = Date.UTC(2026, 0, 5, 10, 0); // minute-aligned
const S = 1000, M = 60_000;
const A = 'EURUSD_otc', B = 'GBPUSD';

const kinds = (es: BuilderEffect[]) => es.map((e) => e.kind);
const closedOf = (es: BuilderEffect[]) => es.flatMap((e) => (e.kind === 'closed' ? [e.candle] : []));

function feedMinute(b: CandleBuilder, asset: string, isOTC: boolean, openTs: number, prices: number[]): void {
  prices.forEach((p, i) => b.onTick(asset, isOTC, openTs + i * 5 * S, p));
}

describe('CandleBuilder', () => {
  it('builds OHLC and tickCount; a tick at exactly openTs opens the new candle', () => {
    const b = new CandleBuilder({ tf: '1m' });
    feedMinute(b, A, true, T, [1.1, 1.3, 1.0, 1.2]);
    expect(b.forming(A)).toEqual({ openTs: T, open: 1.1, high: 1.3, low: 1.0, close: 1.2, tickCount: 4 });
    expect(b.formingTicks(A).map((t) => t.price)).toEqual([1.1, 1.3, 1.0, 1.2]);
    expect(b.drain()).toEqual([]);
    b.onTick(A, true, T + M, 1.25);
    const closed = closedOf(b.drain());
    expect(closed).toEqual([{ asset: A, isOTC: true, tf: '1m', openTs: T, open: 1.1, high: 1.3, low: 1.0, close: 1.2, tickCount: 4, source: 'rebuilt' }]);
    expect(b.forming(A)).toEqual({ openTs: T + M, open: 1.25, high: 1.25, low: 1.25, close: 1.25, tickCount: 1 });
    expect(b.closed(A)).toEqual([{ openTs: T, open: 1.1, high: 1.3, low: 1.0, close: 1.2, tickCount: 4 }]);
  });

  it('a tick one millisecond before the boundary stays in the old candle', () => {
    const b = new CandleBuilder({ tf: '1m' });
    b.onTick(A, true, T, 1);
    b.onTick(A, true, T + M - 1, 2);
    expect(b.forming(A)).toMatchObject({ openTs: T, close: 2, tickCount: 2 });
  });

  it('drops duplicate and out-of-order ticks per asset', () => {
    const b = new CandleBuilder({ tf: '1m' });
    expect(b.onTick(A, true, T + 10 * S, 1.1)).toBe(true);
    expect(b.onTick(A, true, T + 10 * S, 1.2)).toBe(false); // second tab, same tick
    expect(b.onTick(A, true, T + 5 * S, 1.3)).toBe(false);  // lagging tab
    expect(b.onTick(B, false, T + 5 * S, 1.3)).toBe(true);  // other asset unaffected
    expect(b.onTick(A, true, T + 11 * S, 1.4)).toBe(true);
    expect(b.forming(A)).toMatchObject({ open: 1.1, close: 1.4, tickCount: 2 });
    expect(b.dropCounts(A)).toEqual({ duplicate: 1, outOfOrder: 1, late: 0, invalid: 0, partial: 0 });
  });

  it('a clock advance past the boundary closes the candle; later ticks for it are dropped as late', () => {
    const b = new CandleBuilder({ tf: '1m' });
    b.onTick(A, true, T + 50 * S, 1.1);
    b.advance(T + M - 1);
    expect(b.drain()).toEqual([]);
    b.advance(T + M);
    expect(closedOf(b.drain()).map((c) => c.openTs)).toEqual([T]);
    expect(b.forming(A)).toBeNull();
    expect(b.onTick(A, true, T + 55 * S, 1.2)).toBe(false);
    expect(b.dropCounts(A).late).toBe(1);
  });

  it('server time is global: a tick of one asset closes the others', () => {
    const b = new CandleBuilder({ tf: '1m' });
    b.onTick(A, true, T + 30 * S, 1.1);
    b.onTick(B, false, T + 40 * S, 1.3);
    b.onTick(A, true, T + M + 100, 1.2);
    expect(closedOf(b.drain()).map((c) => c.asset).sort()).toEqual([A, B]);
    expect(b.onTick(B, false, T + 59 * S, 1.4)).toBe(false); // its candle already closed
    expect(b.onTick(B, false, T + M + 200, 1.4)).toBe(true);
  });

  it('a minute with no ticks makes no candle and a gap effect', () => {
    const b = new CandleBuilder({ tf: '1m' });
    b.onTick(A, true, T + S, 1.1);
    b.advance(T + 10 * M);
    expect(kinds(b.drain())).toEqual(['closed']);
    expect(b.onTick(A, true, T + 3 * M + 5 * S, 1.2)).toBe(false); // late: minute 3 ended by server time
    b.onTick(A, true, T + 10 * M + 5 * S, 1.2);
    const es = b.drain();
    expect(kinds(es)).toEqual(['gap']);
    expect(es[0]).toEqual({ kind: 'gap', asset: A, isOTC: true, tf: '1m', fromOpenTs: T + M, toOpenTs: T + 10 * M, missing: 9 });
    expect(b.closed(A).map((c) => c.openTs)).toEqual([T]);
  });

  it('the first candle of an asset is not a gap', () => {
    const b = new CandleBuilder({ tf: '1m' });
    b.advance(T + 50 * M);
    b.onTick(A, true, T + 50 * M + S, 1);
    expect(b.drain()).toEqual([]);
  });

  it('a feed candle arriving after close replaces the rebuilt values; small differences are not mismatches', () => {
    const b = new CandleBuilder({ tf: '1m' });
    feedMinute(b, A, true, T, [1.1, 1.2, 1.15]);
    b.advance(T + M);
    b.drain();
    b.onFeedCandle(A, true, '1m', { openTs: T, open: 1.1, high: 1.2000001, low: 1.1, close: 1.15, tickCount: 0 });
    expect(b.drain()).toEqual([]);
    expect(b.closedCandle(A, T)).toEqual({ candle: { openTs: T, open: 1.1, high: 1.2000001, low: 1.1, close: 1.15, tickCount: 0 }, source: 'feed' });
  });

  it('logs a mismatch once when feed and rebuilt differ beyond tolerance', () => {
    const b = new CandleBuilder({ tf: '1m', mismatchRelTol: 1e-5 });
    feedMinute(b, A, true, T, [1.1, 1.2, 1.15]);
    b.advance(T + M);
    b.drain();
    const feed = { openTs: T, open: 1.1, high: 1.21, low: 1.09, close: 1.16, tickCount: 30 };
    b.onFeedCandle(A, true, '1m', feed);
    b.onFeedCandle(A, true, '1m', feed);
    const es = b.drain();
    expect(kinds(es)).toEqual(['mismatch']);
    expect(es[0]).toMatchObject({ kind: 'mismatch', asset: A, openTs: T, feed, rebuilt: { close: 1.15 }, colourDiffers: false });
    expect(b.closed(A)[0]).toEqual(feed);
  });

  it('a colour flip is a mismatch even inside the tolerance', () => {
    const b = new CandleBuilder({ tf: '1m', mismatchRelTol: 1e-3 });
    feedMinute(b, A, true, T, [1.1, 1.1]);
    b.advance(T + M);
    b.drain();
    b.onFeedCandle(A, true, '1m', { openTs: T, open: 1.1, high: 1.10001, low: 1.1, close: 1.10001, tickCount: 2 });
    expect(b.drain()).toMatchObject([{ kind: 'mismatch', colourDiffers: true }]);
  });

  it('a feed candle that arrives while the candle is still forming waits and wins at close', () => {
    const b = new CandleBuilder({ tf: '1m' });
    feedMinute(b, A, true, T, [1.1, 1.2]);
    b.onFeedCandle(A, true, '1m', { openTs: T, open: 1.1, high: 1.3, low: 1.1, close: 1.25, tickCount: 9 });
    expect(b.closed(A)).toEqual([]);
    expect(b.forming(A)).toMatchObject({ close: 1.2 });
    b.advance(T + M);
    const es = b.drain();
    expect(kinds(es)).toEqual(['closed', 'mismatch']);
    expect(closedOf(es)[0]).toMatchObject({ close: 1.2, source: 'rebuilt' });
    expect(b.closedCandle(A, T)).toMatchObject({ candle: { close: 1.25 }, source: 'feed' });
  });

  it('a feed candle fills a minute that had no ticks; other timeframes are ignored', () => {
    const b = new CandleBuilder({ tf: '1m' });
    b.onTick(A, true, T + S, 1.1);
    b.onTick(A, true, T + 2 * M + S, 1.2);
    b.onFeedCandle(A, true, '1m', { openTs: T + M, open: 1.1, high: 1.2, low: 1.1, close: 1.2, tickCount: 3 });
    b.onFeedCandle(A, true, '5m', { openTs: T, open: 1, high: 1, low: 1, close: 1, tickCount: 3 });
    expect(b.closed(A).map((c) => c.openTs)).toEqual([T, T + M]);
    expect(b.closedCandle(A, T + M)!.source).toBe('feed');
  });

  it('a feed candle for a future minute waits until server time passes its close', () => {
    const b = new CandleBuilder({ tf: '1m' });
    b.onTick(A, true, T + S, 1.1);
    b.onFeedCandle(A, true, '1m', { openTs: T + 2 * M, open: 1, high: 1, low: 1, close: 1, tickCount: 1 });
    b.advance(T + 2 * M + 30 * S);
    expect(b.closed(A).map((c) => c.openTs)).toEqual([T]);
    b.advance(T + 3 * M);
    expect(b.closed(A).map((c) => c.openTs)).toEqual([T, T + 2 * M]);
  });

  it('rejects invalid ticks and misaligned feed candles', () => {
    const b = new CandleBuilder({ tf: '1m' });
    expect(b.onTick(A, true, T, Number.NaN)).toBe(false);
    b.onFeedCandle(A, true, '1m', { openTs: T + 1, open: 1, high: 1, low: 1, close: 1, tickCount: 1 });
    expect(b.dropCounts(A).invalid).toBe(2);
  });

  it('keeps at most historyCap closed candles (plus a small trim slack)', () => {
    const b = new CandleBuilder({ tf: '1m', historyCap: 10 });
    for (let i = 0; i < 400; i++) b.onTick(A, true, T + i * M, 1 + i);
    const closed = b.closed(A);
    expect(closed.length).toBeGreaterThanOrEqual(10);
    expect(closed.length).toBeLessThanOrEqual(10 + 256);
    expect(closed[closed.length - 1]!.openTs).toBe(T + 398 * M);
    expect(b.closedCandle(A, T + 390 * M)!.candle.open).toBe(391);
  });

  it('returned forming candles are copies; closed candles are frozen', () => {
    const b = new CandleBuilder({ tf: '1m' });
    b.onTick(A, true, T, 1);
    b.forming(A)!.close = 99;
    expect(b.forming(A)!.close).toBe(1);
    b.advance(T + M);
    expect(Object.isFrozen(b.closed(A)[0])).toBe(true);
    expect(Object.isFrozen(b.formingTicks(A))).toBe(false);
  });
});

describe('CandleBuilder start-up and restore', () => {
  it('drops the first candle when it started before the builder did, and keeps the ones after', () => {
    const b = new CandleBuilder({ tf: '1m', partialStartToleranceMs: 3 * S });
    b.onTick(A, true, T + 20 * S, 1.1); // page opened 20 s into the minute: the real open was missed
    b.onTick(A, true, T + 50 * S, 1.2);
    b.onTick(A, true, T + M, 1.2);
    b.onTick(A, true, T + M + 30 * S, 1.3);
    b.advance(T + 2 * M);
    expect(closedOf(b.drain()).map((c) => c.openTs)).toEqual([T + M]);
    expect(b.dropCounts(A).partial).toBe(1);
  });

  it('keeps the first candle when its first tick is within the tolerance, and is off by default', () => {
    const tolerant = new CandleBuilder({ tf: '1m', partialStartToleranceMs: 3 * S });
    tolerant.onTick(A, true, T + 2 * S, 1.1);
    tolerant.advance(T + M);
    expect(closedOf(tolerant.drain())).toHaveLength(1);
    const off = new CandleBuilder({ tf: '1m' });
    off.onTick(A, true, T + 40 * S, 1.1);
    off.advance(T + M);
    expect(closedOf(off.drain())).toHaveLength(1);
  });

  it("uses the feed's own candle for a dropped partial minute", () => {
    const b = new CandleBuilder({ tf: '1m', partialStartToleranceMs: 3 * S });
    b.onTick(A, true, T + 20 * S, 1.1);
    b.onFeedCandle(A, true, '1m', { openTs: T, open: 1.0, high: 1.2, low: 0.9, close: 1.1, tickCount: 60 });
    b.advance(T + M);
    expect(b.closedCandle(A, T)).toEqual({ candle: expect.objectContaining({ open: 1.0, close: 1.1 }), source: 'feed' });
  });

  it('preloads history silently, then reports the gap to the first live candle', () => {
    const b = new CandleBuilder({ tf: '1m', partialStartToleranceMs: 3 * S });
    const hist = [0, 1, 2].map((i) => ({ candle: { openTs: T + i * M, open: 1, high: 1.1, low: 0.9, close: 1.05, tickCount: 5 }, source: 'rebuilt' as const }));
    b.preload(A, true, hist);
    expect(b.drain()).toEqual([]);
    expect(b.closed(A).map((c) => c.openTs)).toEqual([T, T + M, T + 2 * M]);
    b.onTick(A, true, T + 10 * M + 30 * S, 1.2); // worker restarted mid-candle, minutes later
    b.advance(T + 11 * M);
    const effects = b.drain();
    expect(effects.find((e) => e.kind === 'gap')).toMatchObject({ fromOpenTs: T + 3 * M, toOpenTs: T + 10 * M, missing: 7 });
    expect(closedOf(effects)).toEqual([]); // the restart minute is partial
    expect(b.closed(A)).toHaveLength(3);
  });

  it('refuses to preload over a forming candle', () => {
    const b = new CandleBuilder({ tf: '1m' });
    b.onTick(A, true, T + S, 1);
    expect(() => b.preload(A, true, [])).toThrow(/forming/);
  });
});
