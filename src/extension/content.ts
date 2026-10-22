// ISOLATED-world content script, injected at document_start in every frame of the Quotex page.
// Accepts tap messages only from this same window (the MAIN-world tap posts them), forwards them
// to the service worker over a long-lived port, and mounts the panel in the top frame.

import { FeedBridge } from './content/bridge';
import { mountPanel, type PanelPrefs } from './panel/panel';
import { FEED_PORT, isTapMessage, type PanelRequest, type TapStatus } from './shared/messages';

const isTop = window.top === window;

const alive = () => {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
};

const bridge = new FeedBridge({
  connect: () => chrome.runtime.connect({ name: FEED_PORT }),
  alive,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  now: () => Date.now(),
});

let lastTapStatus: TapStatus | null = null;

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window) return;
  const data: unknown = e.data;
  if (!isTapMessage(data)) return;
  if (data.type === 'status') lastTapStatus = data;
  bridge.send({ type: 'tap', msg: data, origin: location.origin, top: isTop });
});

// ---- panel (top frame only) ----

async function request(req: PanelRequest): Promise<unknown> {
  if (!alive()) throw new Error('The extension was reloaded. Refresh this page.');
  const res: unknown = await chrome.runtime.sendMessage(req);
  if (res === undefined) throw new Error('No response from the service worker.');
  if (typeof res === 'object' && res !== null && (res as { ok?: unknown }).ok === false) {
    throw new Error(String((res as { error?: unknown }).error ?? 'request failed'));
  }
  return res;
}

if (isTop) {
  const start = () => {
    mountPanel(document, {
      request,
      connection: () => ({ bridge: bridge.state, dropped: bridge.dropped, buffered: bridge.buffered, tap: lastTapStatus }),
      loadPrefs: async (): Promise<PanelPrefs> => {
        const r = await chrome.storage.local.get('panelPrefs');
        return { x: null, y: null, collapsed: false, ...(r.panelPrefs as Partial<PanelPrefs> | undefined) };
      },
      savePrefs: (p) => void chrome.storage.local.set({ panelPrefs: p }).catch(() => undefined),
    }).catch(() => undefined);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
