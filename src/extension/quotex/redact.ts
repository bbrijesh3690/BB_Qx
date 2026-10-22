// Redaction applied to every frame before it is stored or exported. Outgoing frames carry the
// session token, so this runs on both directions. Frames with nothing to redact are returned
// byte for byte; redacted frames keep their Socket.IO framing so they still parse.

import { base64ToBytes, bytesToBase64, utf8DecodeStrict, utf8Encode } from './bytes';
import type { WireFrame } from './socketio';

export const SENSITIVE_KEY = /token|session|ssid|auth|password|secret|email|phone|^sid$|^uid$/i;
export const SENSITIVE_EVENT = /auth/i;
export const REDACTED = '[redacted]';

/**
 * Events whose payloads are market data, confirmed in the first recording (2026-10-22). Every other
 * event (balances, orders, trade history, profile, chart settings, ...) is account data the project
 * doesn't need: only its name is kept, so schema tools can still count it.
 */
export const MARKET_EVENTS: ReadonlySet<string> = new Set([
  'quotes/stream', 'instruments/list', 'history/list/v2', 'history/load', 'depth/change',
  'instruments/update', 'depth/follow', 'depth/unfollow', 'chart_notification/get', 's_chart_notification/get', 'tick',
]);
export const ACCOUNT_DATA = '[redacted: account data]';

const isMarketEvent = (name: string) => MARKET_EVENTS.has(name);

/** Socket.IO message prefix up to the JSON body: type, attachment count, namespace, ack id. Or '0' (open). */
const PREFIX = /^(?:4[0-6](?:\d+-)?(?:\/[^,[{"]*,)?\d*|0)(?=[[{"]|$)/;
const REDACTED_JSON_BYTES = utf8Encode(JSON.stringify(REDACTED));
const ACCOUNT_DATA_JSON_BYTES = utf8Encode(JSON.stringify('[redacted: account data]'));
const UNPAIRED_JSON_BYTES = utf8Encode(JSON.stringify('[redacted: unpaired attachment]'));

export interface Redacted<T> {
  value: T;
  changed: boolean;
}

/** Replaces the value of every key matching SENSITIVE_KEY, at any depth. */
export function redactDeep(v: unknown): Redacted<unknown> {
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const r = redactDeep(x);
      changed ||= r.changed;
      return r.value;
    });
    return changed ? { value: out, changed } : { value: v, changed };
  }
  if (typeof v === 'object' && v !== null) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (SENSITIVE_KEY.test(k)) {
        out[k] = REDACTED;
        changed = true;
      } else {
        const r = redactDeep(x);
        changed ||= r.changed;
        out[k] = r.value;
      }
    }
    return changed ? { value: out, changed } : { value: v, changed };
  }
  return { value: v, changed: false };
}

/** Name of a Socket.IO event in a text frame (42 / 43 / 45x-), without parsing the whole body. */
const EVENT_NAME = /^4[235](?:\d+-)?(?:\/[^,[{"]*,)?\d*\["((?:[^"\\]|\\.)*)"/;

/** Redacts one text frame. */
export function redactText(text: string): Redacted<string> {
  const prefix = PREFIX.exec(text)?.[0] ?? '';
  const name = EVENT_NAME.exec(text)?.[1];
  // A binary event header (45x-) only holds placeholders; its attachments are redacted by name.
  if (name !== undefined && !isMarketEvent(name) && !SENSITIVE_EVENT.test(name) && !/^45/.test(prefix)) {
    return { value: prefix + JSON.stringify([name, ACCOUNT_DATA]), changed: true };
  }
  // Every key or event name that could need redacting also matches this, so most frames stop here.
  if (!SENSITIVE_KEY.test(text)) return { value: text, changed: false };
  const body = text.slice(prefix.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Can't tell keys from values: keep the framing, drop the body.
    return { value: prefix + JSON.stringify(REDACTED), changed: true };
  }
  const isEvent = /^4[25]/.test(prefix);
  if (isEvent && Array.isArray(parsed) && typeof parsed[0] === 'string' && SENSITIVE_EVENT.test(parsed[0])) {
    return { value: prefix + JSON.stringify([parsed[0], REDACTED]), changed: true };
  }
  const r = redactDeep(parsed);
  return r.changed ? { value: prefix + JSON.stringify(r.value), changed: true } : { value: text, changed: false };
}

/**
 * Redacts one binary frame (base64). `pendingEvent` is the name of the binary event this frame is
 * an attachment of, if any: attachments of /auth/i events and of non-market events are dropped whole.
 */
export function redactBinary(b64: string, pendingEvent: string | null): Redacted<string> {
  const replaceWhole = (bytes: Uint8Array | null, json: Uint8Array = REDACTED_JSON_BYTES): Redacted<string> => {
    const v3Prefix = bytes !== null && bytes[0] === 0x04;
    const out = v3Prefix ? new Uint8Array([0x04, ...json]) : json;
    return { value: bytesToBase64(out), changed: true };
  };
  const bytes = base64ToBytes(b64);
  // An attachment with no header in front of it can't be told apart from account data.
  if (pendingEvent === null) return replaceWhole(bytes, UNPAIRED_JSON_BYTES);
  if (SENSITIVE_EVENT.test(pendingEvent)) return replaceWhole(bytes);
  if (!isMarketEvent(pendingEvent)) return replaceWhole(bytes, ACCOUNT_DATA_JSON_BYTES);
  if (!bytes) return { value: b64, changed: false };
  const v3Prefix = bytes[0] === 0x04;
  const body = v3Prefix ? bytes.subarray(1) : bytes;
  const text = utf8DecodeStrict(body);
  if (text === null) {
    // Not UTF-8 (msgpack or similar): key names would still appear as plain bytes.
    let latin1 = '';
    for (let i = 0; i < body.length; i++) latin1 += String.fromCharCode(body[i]!);
    return SENSITIVE_KEY.test(latin1) ? replaceWhole(bytes) : { value: b64, changed: false };
  }
  if (!SENSITIVE_KEY.test(text)) return { value: b64, changed: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return replaceWhole(bytes);
  }
  const r = redactDeep(parsed);
  if (!r.changed) return { value: b64, changed: false };
  const json = utf8Encode(JSON.stringify(r.value));
  return { value: bytesToBase64(v3Prefix ? new Uint8Array([0x04, ...json]) : json), changed: true };
}

export function redactFrame(frame: WireFrame, pendingEvent: string | null): Redacted<WireFrame> {
  const r = frame.encoding === 'text' ? redactText(frame.data) : redactBinary(frame.data, pendingEvent);
  return r.changed ? { value: { encoding: frame.encoding, data: r.value }, changed: true } : { value: frame, changed: false };
}

/** Redacts query parameters with sensitive names. Unparseable URLs that look sensitive are dropped. */
export function redactUrl(url: string): string {
  if (!SENSITIVE_KEY.test(url)) return url;
  try {
    const u = new URL(url);
    let changed = false;
    for (const key of [...u.searchParams.keys()]) {
      if (SENSITIVE_KEY.test(key)) {
        u.searchParams.set(key, REDACTED);
        changed = true;
      }
    }
    return changed ? u.toString() : url;
  } catch {
    return REDACTED;
  }
}
