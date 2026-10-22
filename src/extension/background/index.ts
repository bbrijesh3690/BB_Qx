// MV3 service worker (ESM). Wires chrome.* events to the FeedProcessor.
//
// MV3 can stop this worker whenever it is idle, so listeners are registered synchronously at top
// level and every piece of state that matters is in IndexedDB (frames, ticks, candles, payouts),
// chrome.storage.local (recorder) or chrome.storage.session (per-tab and decoder counters).

import { openIndexedDbLedger, type IndexedDbLedger } from '../../ledger/indexeddb';
import { FEED_PORT, isTapMessage, type PanelRequest, type PanelSnapshot, type PortMessage } from '../shared/messages';
import { FeedProcessor, type PersistedFeed } from './feed';
import { checkRecorder, initialRecorder, isRecorderState, setRecorder, type RecorderState } from './recorder';
import { createSink } from './sink';
import { buildSnapshot, candleRows } from './snapshot';

const CLOCK_MS = 1_000; // the brief: a clock event every second while any feed is active
const PERSIST_MS = 2_000; // TUNABLE: how much session state a worker stop can lose
const PRUNE_EVERY_MS = 3_600_000; // TUNABLE: retention is in hours and days, so hourly pruning is plenty
const SNAPSHOT_CACHE_MS = 1_000; // TUNABLE: several tabs poll the panel every second; share one snapshot
const MAX_PENDING = 400; // TUNABLE: queued tasks before batches are dropped (and reported) instead of piling up

interface Ctx {
  ledger: IndexedDbLedger;
  proc: FeedProcessor;
}

let recorder: RecorderState = initialRecorder(Date.now());
let recorderDirty = false;
let lastPruneAt = 0;

const ready: Promise<Ctx> = (async () => {
  const ledger = await openIndexedDbLedger();
  const local = await chrome.storage.local.get(['recorder', 'lastPruneAt']);
  if (isRecorderState(local.recorder)) recorder = local.recorder;
  else recorderDirty = true;
  if (typeof local.lastPruneAt === 'number') lastPruneAt = local.lastPruneAt;
  const proc = new FeedProcessor({
    frames: ledger,
    sink: createSink(ledger),
    getRecorder: () => recorder,
    setRecorder: (s) => updateRecorder(s, ledger, proc),
  });
  try {
    const session = await chrome.storage.session.get('feed');
    if (session.feed) proc.restore(session.feed as PersistedFeed);
  } catch (err) {
    proc.noteError('restoring session state', err, Date.now());
  }
  return { ledger, proc };
})();

function updateRecorder(next: RecorderState, ledger: IndexedDbLedger, proc: FeedProcessor): void {
  const prev = recorder;
  if (next === prev) return;
  recorder = next;
  recorderDirty = true;
  if (prev.on !== next.on) {
    void chrome.storage.local.set({ recorder: next });
    recorderDirty = false;
    const now = Date.now();
    ledger
      .appendEvent({ ts: proc.serverNow(now), kind: 'recorder', payload: { on: next.on, reason: next.stoppedReason, framesThisRun: prev.framesThisRun } })
      .catch((err) => proc.noteError('logging recorder event', err, now));
  }
}

// ---- one ordered queue for everything that touches the processor ----

let chain: Promise<void> = Promise.resolve();
let pending = 0;
let droppedTasks = 0;

function enqueue(task: (ctx: Ctx) => Promise<void> | void): void {
  if (pending >= MAX_PENDING) {
    if (droppedTasks++ % 100 === 0) {
      void ready.then(({ proc }) => proc.noteError('worker', `falling behind: ${droppedTasks} batches dropped`, Date.now()));
    }
    return;
  }
  pending++;
  chain = chain.then(async () => {
    const ctx = await ready;
    try {
      await task(ctx);
    } catch (err) {
      ctx.proc.noteError('processing', err, Date.now());
    } finally {
      pending--;
    }
  });
}

// ---- feed ports from content scripts ----

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== FEED_PORT || port.sender?.id !== chrome.runtime.id) return;
  const tabId = port.sender.tab?.id;
  const frameId = port.sender.frameId ?? 0;
  if (tabId === undefined) return;
  port.onMessage.addListener((m: unknown) => {
    const pm = m as PortMessage | null;
    if (!pm || pm.type !== 'tap' || !isTapMessage(pm.msg)) return;
    const now = Date.now();
    const msg = pm.msg;
    if (msg.type === 'batch') enqueue(({ proc }) => proc.handleBatch(tabId, frameId, msg, now));
    else enqueue(({ proc }) => proc.handleStatus(tabId, frameId, msg));
  });
});

chrome.tabs.onRemoved.addListener((tabId) => enqueue(({ proc }) => proc.removeTab(tabId)));

// ---- clock, recorder limits, retention ----

setInterval(() => {
  enqueue(async ({ ledger, proc }) => {
    const now = Date.now();
    const ev = proc.clockEvent(now);
    if (ev) await proc.emit([ev], now);
    updateRecorder(checkRecorder(recorder, now), ledger, proc);
    if (now - lastPruneAt >= PRUNE_EVERY_MS) {
      lastPruneAt = now;
      await chrome.storage.local.set({ lastPruneAt });
      try {
        await ledger.prune(proc.serverNow(now));
      } catch (err) {
        proc.noteError('prune', err, now);
      }
    }
  });
}, CLOCK_MS);

setInterval(() => {
  void (async () => {
    const { proc } = await ready;
    try {
      if (proc.dirty) {
        proc.dirty = false;
        await chrome.storage.session.set({ feed: proc.persist() });
      }
      if (recorderDirty) {
        recorderDirty = false;
        await chrome.storage.local.set({ recorder });
      }
      proc.sweep(Date.now());
    } catch (err) {
      proc.noteError('persisting state', err, Date.now());
    }
  })();
}, PERSIST_MS);

chrome.runtime.onInstalled.addListener((details) => {
  enqueue(async ({ ledger, proc }) => {
    await ledger.appendEvent({ ts: proc.serverNow(Date.now()), kind: 'reload', payload: { reason: details.reason, version: chrome.runtime.getManifest().version } });
  });
});

chrome.runtime.onStartup.addListener(() => {
  enqueue(async ({ ledger, proc }) => {
    await ledger.appendEvent({ ts: proc.serverNow(Date.now()), kind: 'reload', payload: { reason: 'browser_startup' } });
  });
});

// ---- panel and export page requests ----

let snapshotCache: { at: number; value: Promise<PanelSnapshot> } | null = null;

async function handlePanel(req: PanelRequest): Promise<unknown> {
  const { ledger, proc } = await ready;
  const now = Date.now();
  switch (req.type) {
    case 'panel/snapshot':
      if (!snapshotCache || now - snapshotCache.at > SNAPSHOT_CACHE_MS) {
        snapshotCache = { at: now, value: buildSnapshot(proc, ledger, checkRecorder(recorder, now), now) };
      }
      return snapshotCache.value;
    case 'panel/candles':
      return candleRows(ledger, String(req.asset), Number(req.n) || 50);
    case 'panel/recorder':
      updateRecorder(setRecorder(recorder, Boolean(req.on), now), ledger, proc);
      snapshotCache = null;
      return { ok: true };
    case 'panel/open-export': {
      const what = req.what === 'dataset' ? 'dataset' : 'raw';
      await chrome.tabs.create({ url: chrome.runtime.getURL(`export.html#${what}`) });
      return { ok: true };
    }
    default:
      return { ok: false, error: 'unknown request' };
  }
}

chrome.runtime.onMessage.addListener((req: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const r = req as PanelRequest | null;
  if (!r || typeof r.type !== 'string' || !r.type.startsWith('panel/')) return false;
  handlePanel(r).then(sendResponse, (err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  return true;
});
