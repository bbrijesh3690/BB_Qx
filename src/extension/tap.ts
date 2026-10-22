// Page-side WebSocket tap. Runs in the page's MAIN world (see inject.ts).
//
// Strictly passive: every socket gets one extra 'message' listener, and send() is wrapped to
// observe what the page sends after the original call returns. The originals are always called
// with the exact same arguments, nothing is sent, delayed, modified or dropped, and every error of
// the tap's own is swallowed and counted.

import { bytesToBase64 } from './quotex/bytes';
import { FEED_CHANNEL, type TapBatch, type TapFrame, type TapStatus } from './shared/messages';

const FLUSH_MS = 250; // TUNABLE: batching interval from the brief (~250 ms)
const STATUS_MS = 5_000; // TUNABLE: how often the tap reports that it is alive
const BLOB_TIMEOUT_MS = 5_000; // TUNABLE: give up on a Blob read after this long so the queue keeps moving
const MAX_QUEUE = 50_000; // TUNABLE: frames held between flushes before the oldest are dropped

export interface TapHost {
  WebSocket: unknown;
  postMessage(message: unknown, targetOrigin: string): void;
  setInterval(handler: () => void, timeout: number): unknown;
}

interface Entry {
  frame: TapFrame | null;
  pending: boolean;
  queuedAt: number;
}

const INSTALLED = Symbol.for('quorum.tap.v1');

type AnyFn = (...args: unknown[]) => unknown;

function tagOf(v: unknown): string {
  return Object.prototype.toString.call(v);
}

export interface TapHandle {
  /** Posts queued frames now. Exposed for tests; the interval calls it in production. */
  flush(): void;
  status(): Omit<TapStatus, 'channel' | 'type'>;
}

export function installFeedTap(host: TapHost, now: () => number = Date.now): TapHandle | null {
  const h = host as TapHost & { [INSTALLED]?: TapHandle };
  if (h[INSTALLED]) return h[INSTALLED];
  const Orig = host.WebSocket as (new (...args: unknown[]) => object) | undefined;
  if (typeof Orig !== 'function' || typeof Orig.prototype?.send !== 'function') return null;

  const queue: Entry[] = [];
  const sids = new WeakMap<object, number>();
  let nextSid = 1;
  let openSockets = 0;
  let frames = 0;
  let errors = 0;
  let dropped = 0;

  const push = (e: Entry) => {
    queue.push(e);
    if (queue.length > MAX_QUEUE) {
      queue.shift();
      dropped++;
    }
  };

  const sidOf = (ws: object) => {
    let s = sids.get(ws);
    if (s === undefined) {
      s = nextSid++;
      sids.set(ws, s);
    }
    return s;
  };

  const capture = (ws: object, dir: 'in' | 'out', data: unknown) => {
    const t = now();
    const sid = sidOf(ws);
    const url = String((ws as { url?: unknown }).url ?? '');
    const make = (enc: TapFrame['enc'], payload: string): TapFrame => ({ sid, url, dir, enc, data: payload, t });
    const tag = tagOf(data);
    if (typeof data === 'string') {
      push({ frame: make('text', data), pending: false, queuedAt: t });
    } else if (tag === '[object ArrayBuffer]') {
      push({ frame: make('base64', bytesToBase64(new Uint8Array(data as ArrayBuffer))), pending: false, queuedAt: t });
    } else if (ArrayBuffer.isView(data)) {
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      push({ frame: make('base64', bytesToBase64(bytes)), pending: false, queuedAt: t });
    } else if (tag === '[object Blob]') {
      const entry: Entry = { frame: null, pending: true, queuedAt: t };
      push(entry);
      (data as Blob).arrayBuffer().then(
        (buf) => {
          if (!entry.pending) return;
          entry.frame = make('base64', bytesToBase64(new Uint8Array(buf)));
          entry.pending = false;
        },
        () => {
          entry.pending = false;
          errors++;
        },
      );
    } else {
      return;
    }
    frames++;
  };

  const attach = (ws: object) => {
    const target = ws as { addEventListener?: (type: string, fn: (ev: unknown) => void) => void };
    if (typeof target.addEventListener !== 'function') return;
    openSockets++;
    target.addEventListener('message', (ev: unknown) => {
      try {
        capture(ws, 'in', (ev as { data?: unknown }).data);
      } catch {
        errors++;
      }
    });
    target.addEventListener('close', () => {
      openSockets = Math.max(0, openSockets - 1);
    });
  };

  const Wrapped = new Proxy(Orig, {
    construct(target, args, newTarget) {
      const ws = Reflect.construct(target, args, newTarget) as object;
      try {
        attach(ws);
      } catch {
        errors++;
      }
      return ws;
    },
  });

  const proto = Orig.prototype as { send: AnyFn };
  const origSend = proto.send;
  proto.send = function send(this: object, ...args: unknown[]) {
    // Called first and unchanged; if it throws, the page sees exactly the original error.
    const result = Reflect.apply(origSend, this, args);
    try {
      capture(this, 'out', args[0]);
    } catch {
      errors++;
    }
    return result;
  };

  const flush = () => {
    try {
      const t = now();
      const out: TapFrame[] = [];
      while (queue.length > 0) {
        const head = queue[0]!;
        if (head.pending && t - head.queuedAt < BLOB_TIMEOUT_MS) break;
        queue.shift();
        if (head.frame) out.push(head.frame);
        else {
          head.pending = false;
          dropped++;
        }
      }
      if (out.length > 0) {
        const msg: TapBatch = { channel: FEED_CHANNEL, type: 'batch', frames: out };
        host.postMessage(msg, '*');
      }
    } catch {
      errors++;
    }
  };

  const status = () => ({ sockets: openSockets, frames, errors, dropped });
  const postStatus = () => {
    try {
      const msg: TapStatus = { channel: FEED_CHANNEL, type: 'status', ...status() };
      host.postMessage(msg, '*');
    } catch {
      errors++;
    }
  };

  const handle: TapHandle = { flush, status };
  try {
    Object.defineProperty(host, INSTALLED, { value: handle, enumerable: false });
  } catch {
    // A frozen host still gets a working tap; it just can't be detected twice.
  }
  host.WebSocket = Wrapped;
  host.setInterval(flush, FLUSH_MS);
  host.setInterval(postStatus, STATUS_MS);
  postStatus();
  return handle;
}
