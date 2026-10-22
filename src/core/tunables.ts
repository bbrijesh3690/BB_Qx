// Registry of every assumed number in core, ledger and harness code (BB_Qx.md: "when a number must
// be assumed, mark it // TUNABLE and register it in settings"). Values are phase 0 defaults.
// Code reads TUNABLES.<name>.value; the panel and the harness can list them with listTunables().

export interface Tunable {
  name: string;
  value: number;
  unit: string;
  reason: string;
  /** File that uses the value. */
  source: string;
}

type Entry = Omit<Tunable, 'name'>;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const TUNABLES = {
  // --- extension runtime ---
  partialStartToleranceMs: { // TUNABLE: the first candle seen after a page load or worker restart started without us
    value: 3000, unit: 'ms', reason: 'first candle per asset is dropped when its first tick came this long after its open, so its open and colour would be wrong', source: 'src/extension/background/sink.ts' },
  // --- pipeline ---
  freezeBeforeCloseMs: { // TUNABLE: BB_Qx.md freezes decisions at T-5s; shorter leaves no time to act live
    value: 5000, unit: 'ms', reason: 'BB_Qx.md freezes decisions at T-5s before close', source: 'src/core/pipeline.ts' },
  confirmDelayMs: { // TUNABLE: time after close to wait for the feed's own candle before scoring
    value: 2000, unit: 'ms', reason: 'wait after close for the feed candle so scoring uses the feed close, not the rebuilt one', source: 'src/core/pipeline.ts' },
  defaultPayoutPercent: { // TUNABLE: conservative until a payout event is seen
    value: 80, unit: 'percent', reason: 'used until a payout is seen; 80% is the low end in BB_Qx.md, so break-even (55.6%) errs high', source: 'src/core/pipeline.ts' },
  contextCandles: { // TUNABLE: longest rolling window in the roster (feed-structure, up to 1,000 candles)
    value: 1000, unit: 'candles', reason: 'closed candles passed in Context; covers the feed-structure engine window of 200-1,000', source: 'src/core/pipeline.ts' },
  tickBatchSize: { // TUNABLE: performance only, no effect on results
    value: 2000, unit: 'ticks', reason: 'ticks buffered before one ledger write; affects speed only', source: 'src/core/pipeline.ts' },

  // --- candle builder ---
  candleMismatchRelTol: { // TUNABLE: about one point on a 5-decimal quote near 1.0
    value: 1e-5, unit: 'fraction of price', reason: 'feed vs rebuilt OHLC differences above this are logged as candle_mismatch; about one point at 5 decimals', source: 'src/core/candles.ts' },

  // --- sessions ---
  liveCloseFridayHourUtc: { // TUNABLE: usual retail forex weekly close
    value: 21, unit: 'hour UTC', reason: 'live forex closes Friday 21:00 UTC (typical retail broker hours); OTC never closes', source: 'src/core/time.ts' },
  liveOpenSundayHourUtc: { // TUNABLE: usual retail forex weekly open
    value: 21, unit: 'hour UTC', reason: 'live forex reopens Sunday 21:00 UTC (typical retail broker hours)', source: 'src/core/time.ts' },

  // --- retention (values from BB_Qx.md, registered so both ledgers share them) ---
  retentionTicksMs: { // TUNABLE: phase 0 replay gate needs a recorded day; revisit after the gate
    value: 26 * HOUR_MS, unit: 'ms', reason: 'BB_Qx.md says 2 h; raised for phase 0 so a full recorded day of ticks (about 100 MB for 5 assets) can be exported and replayed without keeping 24 h of raw frames (about 1 GB)', source: 'src/ledger/memory.ts' },
  retentionCandlesMs: { // TUNABLE: BB_Qx.md candle retention before thinning
    value: 30 * DAY_MS, unit: 'ms', reason: 'BB_Qx.md: 1m candles kept 30 days, then thinned to 5m', source: 'src/ledger/memory.ts' },
  retentionPayoutsMs: { // TUNABLE: BB_Qx.md payouts and feed_structure retention
    value: 30 * DAY_MS, unit: 'ms', reason: 'BB_Qx.md: payouts and feed_structure kept 30 days', source: 'src/ledger/memory.ts' },

  // --- synthetic generators ---
  syntheticSigma: { // TUNABLE: about 2 pips per 1m candle on EUR/USD
    value: 0.0002, unit: 'log-price per candle', reason: 'per-candle volatility of synthetic feeds; about 2 pips per minute on EUR/USD', source: 'src/harness/generators.ts' },
  syntheticTicksPerCandle: { // TUNABLE: speed vs realism; real feeds send roughly 1 tick per second
    value: 12, unit: 'ticks', reason: 'ticks per synthetic candle (one every 5 s on 1m); real feeds send more, kept low for speed', source: 'src/harness/generators.ts' },
  syntheticDecimals: { // TUNABLE: typical forex quote precision
    value: 5, unit: 'decimals', reason: 'synthetic prices rounded like a 5-decimal forex quote, which yields realistic ties (close == open)', source: 'src/harness/generators.ts' },
  syntheticBoundedK: { // TUNABLE: from BB_Qx.md Evidence
    value: 0.08, unit: 'per candle', reason: 'anchor pull of the bounded generator; BB_Qx.md Evidence used k = 0.08', source: 'src/harness/generators.ts' },
  syntheticTrendDrift: { // TUNABLE: 0.15 sigma per candle, about 56% up candles
    value: 0.00003, unit: 'log-price per candle', reason: 'drift of the trending generator: 0.15 sigma, so about 56% of candles close up', source: 'src/harness/generators.ts' },
  syntheticRegimeCandles: { // TUNABLE: long enough per regime for a 200-1,000 candle window to notice
    value: 2000, unit: 'candles', reason: 'candles per regime in regimeSwitching before moving to the next', source: 'src/harness/generators.ts' },
  syntheticPayoutOtcPercent: { // TUNABLE: typical OTC payout seen on Quotex
    value: 85, unit: 'percent', reason: 'payout of synthetic OTC assets', source: 'src/harness/generators.ts' },
  syntheticPayoutLivePercent: { // TUNABLE: typical live-pair payout
    value: 80, unit: 'percent', reason: 'payout of synthetic live assets', source: 'src/harness/generators.ts' },
} as const satisfies Record<string, Entry>;

export type TunableName = keyof typeof TUNABLES;

export function tunable(name: TunableName): number {
  return TUNABLES[name].value;
}

/** Every registered tunable, sorted by name. */
export function listTunables(): Tunable[] {
  return (Object.keys(TUNABLES) as TunableName[])
    .sort()
    .map((name) => ({ name, ...TUNABLES[name] }));
}
