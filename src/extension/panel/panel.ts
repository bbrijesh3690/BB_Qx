// On-page panel (phase 0). Lives in a closed shadow root on a host element the content script adds
// to the page; it touches nothing else in the page's DOM. All data comes from the service worker.

import type { BridgeState } from '../content/bridge';
import type { CandleRow, PanelRequest, PanelSnapshot, TapStatus } from '../shared/messages';
import { PANEL_CSS } from './styles';
import {
  ageText, aliveDot, candleColour, defaultSpotAsset, headerDot, int, priceDecimals, recorderText, storedText,
  unknownSummary, utcMinute,
} from './view';

const POLL_MS = 1_000; // TUNABLE: snapshot refresh; the worker caches snapshots for the same interval
const SPOT_POLL_MS = 5_000; // TUNABLE: spot-check list refresh while it is open
const REQUEST_TIMEOUT_MS = 5_000; // TUNABLE: a worker that has not answered by now is reported as not responding
const SPOT_CANDLES = 50;

export interface PanelPrefs {
  x: number | null;
  y: number | null;
  collapsed: boolean;
}

export interface PanelDeps {
  request(req: PanelRequest): Promise<unknown>;
  connection(): { bridge: BridgeState; dropped: number; buffered: number; tap: TapStatus | null };
  loadPrefs(): Promise<PanelPrefs>;
  savePrefs(p: PanelPrefs): void;
}

type Child = Node | string | null | undefined | false;

function make(doc: Document) {
  return function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, ...children: Child[]): HTMLElementTagNameMap[K] {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
    return e;
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}: no answer from the service worker after ${ms / 1000}s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e); });
  });
}

export async function mountPanel(doc: Document, deps: PanelDeps): Promise<void> {
  const el = make(doc);
  const host = doc.createElement('div');
  host.id = 'quorum-panel-host';
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; top: 72px; right: 16px;';
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = PANEL_CSS;

  const dot = el('span', 'dot grey');
  const summary = el('span', 'sum', 'starting…');
  const collapseBtn = el('button', 'icon', '–');
  collapseBtn.title = 'Collapse / expand';
  const head = el('div', 'head', dot, el('b', '', 'Quorum'), summary, collapseBtn);

  const banner = el('div', 'banner');
  const assetsBox = el('section');
  const recLine = el('div');
  const storedLine = el('div', 'muted');
  const recBtn = el('button', '', 'Stop recorder');
  const rawBtn = el('button', '', 'Export raw frames');
  const dataBtn = el('button', '', 'Export dataset');
  const recBox = el('section', '', el('h3', '', 'Recorder'), recLine, storedLine, el('div', 'row', recBtn, rawBtn, dataBtn));
  const tabsBox = el('section');
  const decodeBox = el('section');
  const spotSelect = el('select');
  const spotTable = el('div');
  const spot = el('details', '', el('summary', '', `Spot-check: last ${SPOT_CANDLES} 1m candles (UTC)`), spotSelect, spotTable);
  const connBox = el('section', 'muted');
  const errBox = el('section', 'errs');
  const body = el('div', 'body', banner, assetsBox, recBox, tabsBox, decodeBox, spot, connBox, errBox);
  const panel = el('div', 'panel', head, body);
  root.append(style, panel);

  let prefs: PanelPrefs = { x: null, y: null, collapsed: false };
  try {
    prefs = await deps.loadPrefs();
  } catch {
    // Defaults are fine.
  }
  const place = () => {
    if (prefs.x === null || prefs.y === null) return;
    const w = doc.defaultView?.innerWidth ?? 1200;
    const h = doc.defaultView?.innerHeight ?? 800;
    const x = Math.min(Math.max(0, prefs.x), Math.max(0, w - 120));
    const y = Math.min(Math.max(0, prefs.y), Math.max(0, h - 30));
    host.style.left = `${x}px`;
    host.style.top = `${y}px`;
    host.style.right = 'auto';
  };
  place();
  panel.classList.toggle('collapsed', prefs.collapsed);
  collapseBtn.textContent = prefs.collapsed ? '+' : '–';
  (doc.body ?? doc.documentElement).append(host);

  // ---- drag and collapse ----
  let drag: { dx: number; dy: number } | null = null;
  head.addEventListener('pointerdown', (e) => {
    if ((e.target as Element).closest('button')) return;
    const r = host.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag) return;
    prefs = { ...prefs, x: e.clientX - drag.dx, y: e.clientY - drag.dy };
    place();
  });
  head.addEventListener('pointerup', () => {
    if (!drag) return;
    drag = null;
    deps.savePrefs(prefs);
  });
  collapseBtn.addEventListener('click', () => {
    prefs = { ...prefs, collapsed: !prefs.collapsed };
    panel.classList.toggle('collapsed', prefs.collapsed);
    collapseBtn.textContent = prefs.collapsed ? '+' : '–';
    deps.savePrefs(prefs);
  });

  // ---- data ----
  let snap: PanelSnapshot | null = null;
  let lastError: string | null = null;
  let spotAsset: string | null = null;

  const ask = (req: PanelRequest) => withTimeout(deps.request(req), REQUEST_TIMEOUT_MS, req.type);

  recBtn.addEventListener('click', () => {
    if (!snap) return;
    void ask({ type: 'panel/recorder', on: !snap.recorder.on }).then(poll, showError);
  });
  rawBtn.addEventListener('click', () => void ask({ type: 'panel/open-export', what: 'raw' }).catch(showError));
  dataBtn.addEventListener('click', () => void ask({ type: 'panel/open-export', what: 'dataset' }).catch(showError));
  spotSelect.addEventListener('change', () => {
    spotAsset = spotSelect.value || null;
    void refreshSpot();
  });
  spot.addEventListener('toggle', () => void refreshSpot());

  function showError(e: unknown) {
    lastError = e instanceof Error ? e.message : String(e);
    render();
  }

  async function poll() {
    try {
      snap = (await ask({ type: 'panel/snapshot' })) as PanelSnapshot;
      lastError = null;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    render();
  }

  async function refreshSpot() {
    if (!spot.open || !spotAsset) {
      spotTable.replaceChildren();
      return;
    }
    try {
      const rows = (await ask({ type: 'panel/candles', asset: spotAsset, n: SPOT_CANDLES })) as CandleRow[];
      spotTable.replaceChildren(renderCandles(rows));
    } catch (e) {
      spotTable.replaceChildren(el('div', 'empty', `Could not load candles: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  function renderCandles(rows: CandleRow[]): Node {
    if (rows.length === 0) return el('div', 'empty', 'No 1m candles stored for this asset yet.');
    const d = priceDecimals(rows);
    const f = (x: number) => x.toFixed(d);
    const table = el('table', '', el('tr', '', ...['Open (UTC)', 'O', 'H', 'L', 'C', ''].map((h, i) => el('th', i > 0 && i < 5 ? 'num' : '', h))));
    for (const c of [...rows].reverse()) {
      const colour = candleColour(c);
      const tr = el('tr', '',
        el('td', '', utcMinute(c.openTs).slice(5)),
        el('td', 'num', f(c.open)), el('td', 'num', f(c.high)), el('td', 'num', f(c.low)), el('td', 'num', f(c.close)),
        el('td', '', el('span', `chip ${colour}`), colour, c.source === 'rebuilt' ? el('span', 'muted', ' (rebuilt)') : null),
      );
      table.append(tr);
    }
    return table;
  }

  function render() {
    const conn = deps.connection();
    if (!host.isConnected) (doc.body ?? doc.documentElement).append(host);

    const problems: string[] = [];
    if (conn.bridge === 'dead') problems.push('The extension was reloaded or removed. Refresh this page to reconnect.');
    if (lastError) problems.push(lastError);
    banner.textContent = problems.join(' ');
    banner.classList.toggle('show', problems.length > 0);

    dot.className = `dot ${headerDot(snap)}`;
    if (!snap) {
      summary.textContent = lastError ? 'service worker not responding' : 'connecting…';
      assetsBox.replaceChildren(el('div', 'empty', 'Waiting for the service worker…'));
    } else {
      renderSnapshot(snap);
    }
    connBox.replaceChildren(
      el('h3', '', 'Connection'),
      el('div', '', `worker port: ${conn.bridge}${conn.buffered ? ` (${conn.buffered} batches waiting)` : ''}${conn.dropped ? ` · ${int(conn.dropped)} batches dropped` : ''}`),
      el('div', '', conn.tap
        ? `page tap (this frame): ${conn.tap.sockets} sockets · ${int(conn.tap.frames)} frames · ${conn.tap.errors} errors · ${conn.tap.dropped} dropped`
        : 'page tap: no report yet from this frame (it may live in an iframe)'),
    );
  }

  function renderSnapshot(s: PanelSnapshot) {
    const live = s.assets.filter((a) => aliveDot(a.lastTickAgeMs) === 'green').length;
    summary.textContent = `rec ${s.recorder.on ? 'ON' : 'OFF'} · ${live}/${s.assets.length} assets live · ${s.tabs.length} tab${s.tabs.length === 1 ? '' : 's'}`;

    if (s.framesSeen === 0 && s.assets.length === 0) {
      assetsBox.replaceChildren(el('h3', '', 'Assets'), el('div', 'empty', 'No frames seen yet. Open a Quotex chart in this tab; the panel fills in once the page’s WebSocket delivers data.'));
    } else if (s.assets.length === 0) {
      assetsBox.replaceChildren(el('h3', '', 'Assets'), el('div', 'empty', `${int(s.framesSeen)} frames seen, but no ticks decoded yet. Check the unknown event names below; the decoder mapping may need fixing.`));
    } else {
      const table = el('table', '', el('tr', '', ...['', 'Asset', 'Type', 'Ticks', '1m', 'Last tick', 'Payout', 'Tabs'].map((h, i) => el('th', i >= 3 && i <= 6 ? 'num' : '', h))));
      for (const a of s.assets) {
        const tr = el('tr', a.tabs.includes(s.selfTabId ?? -1) ? 'self' : '',
          el('td', '', el('span', `dot ${aliveDot(a.lastTickAgeMs)}`)),
          el('td', '', a.asset),
          el('td', '', a.isOTC ? 'OTC' : 'live'),
          el('td', 'num', int(a.ticksStored)),
          el('td', 'num', int(a.candles1m)),
          el('td', 'num', ageText(a.lastTickAgeMs)),
          el('td', 'num', a.payout === null ? '—' : `${a.payout}%`),
          el('td', '', a.tabs.length ? a.tabs.map((t) => (t === s.selfTabId ? `#${t}*` : `#${t}`)).join(' ') : '—'),
        );
        table.append(tr);
      }
      assetsBox.replaceChildren(el('h3', '', 'Assets'), table);
    }

    recLine.textContent = recorderText(s.recorder);
    storedLine.textContent = storedText(s.recorder);
    recBtn.textContent = s.recorder.on ? 'Stop recorder' : 'Start recorder';

    const tabList = el('ul');
    for (const t of s.tabs) {
      const age = s.now - t.lastFrameAt;
      const li = el('li', t.tabId === s.selfTabId ? 'muted' : '',
        `#${t.tabId}${t.tabId === s.selfTabId ? ' (this tab)' : ''}: viewing ${t.viewing ?? '?'} · feeds ${t.assets.join(', ') || 'nothing yet'} · last frame ${ageText(t.lastFrameAt ? age : null)} ago · ${int(t.frames)} frames`,
        t.tap ? ` · tap ${t.tap.sockets} sockets, ${t.tap.errors} errors` : '',
      );
      li.title = t.socketUrls.join('\n');
      tabList.append(li);
    }
    tabsBox.replaceChildren(el('h3', '', 'Tabs'), s.tabs.length ? tabList : el('div', 'empty', 'No tab has sent frames yet.'));

    const d = s.decode;
    decodeBox.replaceChildren(
      el('h3', '', 'Decoder (schema unconfirmed)'),
      el('div', '', `unknown event names: ${unknownSummary(s)}`),
      el('div', 'muted', `ticks ${int(d.ticks)} (dup ${int(d.duplicateTicks)}, late ${int(d.staleTicks)}, rejected ${int(d.ticksRejected)}) · candles ${int(d.candles)} (rejected ${int(d.candlesRejected)}, still open ${int(d.candlesSkippedOpen)}) · payouts ${int(d.payouts)} · bad payloads ${int(d.badPayloads)} · unparsed frames ${int(d.unknownFrames)} · orphan binaries ${int(d.orphanBinaries)}`),
      el('div', 'muted', `server offset: ${s.serverOffsetMs === null ? 'unknown (no ticks yet)' : `${Math.round(s.serverOffsetMs)} ms`}`),
    );

    const next = defaultSpotAsset(s, spotAsset);
    const names = s.assets.map((a) => a.asset);
    if (names.join('|') !== [...spotSelect.options].map((o) => o.value).join('|')) {
      spotSelect.replaceChildren(...names.map((n) => {
        const o = el('option', '', n);
        o.value = n;
        return o;
      }));
    }
    if (next !== spotAsset) {
      spotAsset = next;
      void refreshSpot();
    }
    if (spotAsset) spotSelect.value = spotAsset;

    errBox.replaceChildren(...(s.errors.length ? [el('h3', '', 'Worker errors'), el('ul', '', ...s.errors.slice(-5).map((e) => el('li', '', e)))] : []));
  }

  render();
  const loop = async () => {
    await poll();
    setTimeout(() => void loop(), POLL_MS);
  };
  void loop();
  setInterval(() => void refreshSpot(), SPOT_POLL_MS);
}
