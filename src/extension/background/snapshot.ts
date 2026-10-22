// Builds what the panel shows from the processor's in-memory state and the ledger.

import type { CandleRecord, PayoutRecord, Timeframe } from '../../core/contracts';
import { isOtcAsset } from '../quotex/decoder';
import type { AssetRow, CandleRow, PanelSnapshot } from '../shared/messages';
import type { FeedProcessor } from './feed';
import { RECORDER_FRAME_CAP, timeLeftMs, type RecorderState } from './recorder';

const MAX_ASSETS = 30; // TUNABLE: rows in the panel; 5 assets are expected, the rest is headroom for a feed that carries more

export interface SnapshotLedger {
  countRawFrames(): Promise<number>;
  countTicks(asset: string): Promise<number>;
  countCandles(): Promise<Record<string, number>>;
  latestPayout(asset: string, atOrBeforeTs: number): Promise<PayoutRecord | null>;
  assetsIn(store: 'ticks'): Promise<string[]>;
  candleSeries(): Promise<[string, Timeframe][]>;
  lastCandles(asset: string, tf: Timeframe, n: number): Promise<CandleRecord[]>;
}

export async function buildSnapshot(proc: FeedProcessor, ledger: SnapshotLedger, recorder: RecorderState, now: number): Promise<PanelSnapshot> {
  const serverNow = proc.serverNow(now);
  const session = new Map(proc.assetViews(now).map((a) => [a.asset, a]));
  const [tickAssets, series, candleCounts, framesStored] = await Promise.all([
    ledger.assetsIn('ticks'),
    ledger.candleSeries(),
    ledger.countCandles(),
    ledger.countRawFrames(),
  ]);
  const names = new Set<string>([...session.keys(), ...tickAssets, ...series.filter(([, tf]) => tf === '1m').map(([a]) => a)]);
  const lastSeen = (a: string) => session.get(a)?.lastTickLocal ?? 0;
  const chosen = [...names].sort((a, b) => lastSeen(b) - lastSeen(a) || (a < b ? -1 : 1)).slice(0, MAX_ASSETS);

  const assets: AssetRow[] = await Promise.all(
    chosen.map(async (asset) => {
      const s = session.get(asset);
      const [ticksStored, payout] = await Promise.all([ledger.countTicks(asset), ledger.latestPayout(asset, serverNow)]);
      return {
        asset,
        isOTC: isOtcAsset(asset),
        ticksStored,
        candles1m: candleCounts[`${asset}|1m`] ?? 0,
        lastTickAgeMs: s && s.lastTickLocal > 0 ? Math.max(0, now - s.lastTickLocal) : null,
        payout: payout?.percent ?? null,
        tabs: s?.tabs ?? [],
      };
    }),
  );
  assets.sort((a, b) => (a.asset < b.asset ? -1 : 1));

  return {
    now,
    serverOffsetMs: proc.offset.offset(),
    framesSeen: proc.framesSeen,
    tabs: proc.tabViews(),
    assets,
    recorder: {
      on: recorder.on,
      startedAt: recorder.startedAt,
      stoppedReason: recorder.stoppedReason,
      framesThisRun: recorder.framesThisRun,
      framesStored,
      approxMB: recorder.bytesTotal / 1_048_576,
      timeLeftMs: timeLeftMs(recorder, now),
      frameCap: RECORDER_FRAME_CAP,
    },
    unknownEvents: proc.unknownEvents(),
    decode: proc.decodeView(),
    errors: [...proc.errors],
  };
}

export async function candleRows(ledger: SnapshotLedger, asset: string, n: number): Promise<CandleRow[]> {
  const rows = await ledger.lastCandles(asset, '1m', Math.max(1, Math.min(200, Math.floor(n))));
  return rows.map((c) => ({ openTs: c.openTs, open: c.open, high: c.high, low: c.low, close: c.close, source: c.source }));
}
