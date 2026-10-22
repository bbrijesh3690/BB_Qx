// Engine.IO / Socket.IO frame parser. Pure and tolerant: anything it does not recognise becomes an
// 'unknown' packet; it never throws.
//
// Text frames: one Engine.IO packet each. '0' open, '1' close, '2' ping, '3' pong, '4' message
// (carrying a Socket.IO packet), '5' upgrade, '6' noop. Socket.IO packets inside '4':
// '0' connect, '1' disconnect, '2' event, '3' ack, '4' connect error, '5' binary event,
// '6' binary ack. Layout: <type>[<attachments>-][<nsp>,][<ack id>][<json>], e.g.
//   42["quotes/stream",...]   421["x"]   42/chat,["x"]   451-["ev",{"_placeholder":true,"num":0}]
// Binary frames carry the attachments of the latest binary event, one frame each. With Engine.IO
// v3 they start with a 0x04 byte (the message type); with v4 they do not.

import { base64ToBytes, utf8DecodeStrict } from './bytes';

export interface WireFrame {
  encoding: 'text' | 'base64';
  data: string;
}

export type Packet =
  | { type: 'open'; data: unknown }
  | { type: 'close' }
  | { type: 'ping'; data: string }
  | { type: 'pong'; data: string }
  | { type: 'upgrade' }
  | { type: 'noop' }
  | { type: 'connect'; nsp: string; data: unknown }
  | { type: 'disconnect'; nsp: string }
  | { type: 'connect_error'; nsp: string; data: unknown }
  | { type: 'event'; nsp: string; ackId: number | null; name: string; args: unknown[] }
  | { type: 'ack'; nsp: string; ackId: number | null; args: unknown[] }
  | { type: 'binary_event'; nsp: string; ackId: number | null; name: string; args: unknown[]; attachments: number }
  | { type: 'binary_ack'; nsp: string; ackId: number | null; args: unknown[]; attachments: number }
  | { type: 'binary'; bytes: Uint8Array }
  | { type: 'unknown'; reason: string };

const unknown = (reason: string): Packet => ({ type: 'unknown', reason });

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

export function parseFrame(frame: WireFrame): Packet {
  if (frame.encoding === 'base64') {
    const bytes = base64ToBytes(frame.data);
    return bytes ? { type: 'binary', bytes } : unknown('bad base64');
  }
  return parseText(frame.data);
}

export function parseText(s: string): Packet {
  if (s.length === 0) return unknown('empty');
  const rest = s.slice(1);
  switch (s[0]) {
    case '0': {
      const j = parseJson(rest);
      return j.ok ? { type: 'open', data: j.value } : unknown('bad open json');
    }
    case '1':
      return { type: 'close' };
    case '2':
      return { type: 'ping', data: rest };
    case '3':
      return { type: 'pong', data: rest };
    case '4':
      return parseSocketIo(rest);
    case '5':
      return { type: 'upgrade' };
    case '6':
      return { type: 'noop' };
    default:
      return unknown('not engine.io');
  }
}

function parseSocketIo(s: string): Packet {
  if (s.length === 0) return unknown('empty socket.io packet');
  const sioType = s[0]!;
  if (!/[0-6]/.test(sioType)) return unknown('bad socket.io type');
  let i = 1;

  let attachments = 0;
  if (sioType === '5' || sioType === '6') {
    const dash = s.indexOf('-', i);
    const n = dash < 0 ? NaN : Number(s.slice(i, dash));
    if (!Number.isInteger(n) || n < 0) return unknown('bad attachment count');
    attachments = n;
    i = dash + 1;
  }

  let nsp = '/';
  if (s[i] === '/') {
    const comma = s.indexOf(',', i);
    const end = comma < 0 ? s.length : comma;
    nsp = s.slice(i, end);
    i = comma < 0 ? s.length : comma + 1;
  }

  let ackId: number | null = null;
  const digits = /^\d+/.exec(s.slice(i));
  if (digits) {
    ackId = Number(digits[0]);
    i += digits[0].length;
  }

  const body = s.slice(i);
  let data: unknown;
  if (body.length > 0) {
    const j = parseJson(body);
    if (!j.ok) return unknown('bad socket.io json');
    data = j.value;
  }

  switch (sioType) {
    case '0':
      return { type: 'connect', nsp, data };
    case '1':
      return { type: 'disconnect', nsp };
    case '4':
      return { type: 'connect_error', nsp, data };
    case '2':
    case '5': {
      if (!Array.isArray(data) || typeof data[0] !== 'string') return unknown('event without a name');
      const [name, ...args] = data as [string, ...unknown[]];
      return sioType === '2'
        ? { type: 'event', nsp, ackId, name, args }
        : { type: 'binary_event', nsp, ackId, name, args, attachments };
    }
    default: {
      // '3' ack, '6' binary ack
      const args = Array.isArray(data) ? data : data === undefined ? [] : [data];
      return sioType === '3' ? { type: 'ack', nsp, ackId, args } : { type: 'binary_ack', nsp, ackId, args, attachments };
    }
  }
}

/** An event with every binary placeholder replaced by its attachment bytes. */
export interface SocketEvent {
  name: string;
  nsp: string;
  ackId: number | null;
  args: unknown[];
  /** Number of binary attachments this event carried (0 for a plain '42' event). */
  attachments: number;
}

export function isPlaceholder(v: unknown): v is { _placeholder: true; num: number } {
  return typeof v === 'object' && v !== null && (v as { _placeholder?: unknown })._placeholder === true && typeof (v as { num?: unknown }).num === 'number';
}

/** Replaces {_placeholder:true,num:n} anywhere in `v` by attachments[n]; leaves it when n is out of range. */
export function fillPlaceholders(v: unknown, attachments: readonly Uint8Array[]): unknown {
  if (isPlaceholder(v)) return attachments[v.num] ?? v;
  if (Array.isArray(v)) return v.map((x) => fillPlaceholders(x, attachments));
  if (typeof v === 'object' && v !== null && !(v instanceof Uint8Array)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = fillPlaceholders(x, attachments);
    return out;
  }
  return v;
}

/**
 * Pairs binary-event headers with the binary frames that follow them, per socket. Feed it every
 * packet of one socket in order. Binary acks are consumed like events but produce nothing.
 */
export class BinaryAssembler {
  private pending: { name: string | null; nsp: string; ackId: number | null; args: unknown[]; need: number; got: Uint8Array[] } | null = null;
  /** Binary frames that arrived with no header waiting for them. */
  orphanBinaries = 0;
  /** Headers whose attachments never all arrived before the next text packet. */
  incompleteHeaders = 0;

  /** Name of the binary event currently waiting for attachments, or null. */
  pendingEventName(): string | null {
    return this.pending?.name ?? null;
  }

  isAwaitingAttachments(): boolean {
    return this.pending !== null;
  }

  push(p: Packet): SocketEvent | null {
    if (p.type === 'binary') {
      if (!this.pending) {
        this.orphanBinaries++;
        return null;
      }
      this.pending.got.push(p.bytes);
      return this.pending.got.length >= this.pending.need ? this.complete() : null;
    }
    if (this.pending) {
      this.incompleteHeaders++;
      this.pending = null;
    }
    switch (p.type) {
      case 'event':
        return { name: p.name, nsp: p.nsp, ackId: p.ackId, args: p.args, attachments: 0 };
      case 'binary_event':
      case 'binary_ack': {
        const name = p.type === 'binary_event' ? p.name : null;
        this.pending = { name, nsp: p.nsp, ackId: p.ackId, args: p.args, need: p.attachments, got: [] };
        return p.attachments === 0 ? this.complete() : null;
      }
      default:
        return null;
    }
  }

  private complete(): SocketEvent | null {
    const pend = this.pending!;
    this.pending = null;
    if (pend.name === null) return null;
    return { name: pend.name, nsp: pend.nsp, ackId: pend.ackId, args: pend.args.map((a) => fillPlaceholders(a, pend.got)), attachments: pend.need };
  }
}

/**
 * Text of a binary attachment, for attachments that carry JSON. Strips the Engine.IO v3 0x04
 * prefix when present. Null when the bytes are not valid UTF-8.
 */
export function attachmentText(bytes: Uint8Array): string | null {
  const body = bytes.length > 0 && bytes[0] === 0x04 ? bytes.subarray(1) : bytes;
  return utf8DecodeStrict(body);
}

/** JSON value of a binary attachment, or undefined when it is not JSON. */
export function attachmentJson(bytes: Uint8Array): unknown {
  const text = attachmentText(bytes);
  if (text === null) return undefined;
  const j = parseJson(text);
  return j.ok ? j.value : undefined;
}
