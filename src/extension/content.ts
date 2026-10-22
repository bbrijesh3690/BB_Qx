// ISOLATED-world content script, injected at document_start in every frame of the Quotex page.
// Accepts tap messages only from this same window (the MAIN-world tap posts them), forwards them
// to the service worker over a long-lived port, and mounts the panel in the top frame.

import { FeedBridge } from './content/bridge';
import { FEED_PORT, isTapMessage, type TapStatus } from './shared/messages';

const isTop = window.top === window;

export const bridge = new FeedBridge({
  connect: () => chrome.runtime.connect({ name: FEED_PORT }),
  alive: () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  now: () => Date.now(),
});

export let lastTapStatus: TapStatus | null = null;

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window) return;
  const data: unknown = e.data;
  if (!isTapMessage(data)) return;
  if (data.type === 'status') lastTapStatus = data;
  bridge.send({ type: 'tap', msg: data, origin: location.origin, top: isTop });
});
