import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64, utf8Decode, utf8Encode } from './bytes';
import { REDACTED, redactBinary, redactDeep, redactFrame, redactText, redactUrl } from './redact';
import { BinaryAssembler, parseFrame, parseText } from './socketio';

const b64 = (text: string, prefix04 = false) => {
  const body = utf8Encode(text);
  return bytesToBase64(prefix04 ? new Uint8Array([4, ...body]) : body);
};
const text = (b: string) => utf8Decode(base64ToBytes(b)!);

describe('redactDeep', () => {
  it('replaces values of sensitive keys at any depth, case-insensitively', () => {
    const input = {
      a: 1,
      SessionId: 'abc',
      nested: { userEmail: 'x@y', list: [{ phoneNumber: '1' }, { ok: true }], AUTH_KEY: { deep: 1 } },
      api_token: 5,
      ssid: 's',
      password: 'p',
      clientSecret: 'c',
    };
    expect(redactDeep(input)).toEqual({
      changed: true,
      value: {
        a: 1,
        SessionId: REDACTED,
        nested: { userEmail: REDACTED, list: [{ phoneNumber: REDACTED }, { ok: true }], AUTH_KEY: REDACTED },
        api_token: REDACTED,
        ssid: REDACTED,
        password: REDACTED,
        clientSecret: REDACTED,
      },
    });
  });

  it('reports unchanged when nothing matches, even if values mention sensitive words', () => {
    const v = { msg: 'session expired', list: ['token'] };
    expect(redactDeep(v)).toEqual({ value: v, changed: false });
  });
});

describe('redactText', () => {
  it('redacts the whole payload of an auth event and keeps the frame parseable', () => {
    const frame = '42["authorization",{"session":"SECRET-TOKEN","isDemo":1,"tournamentId":0}]';
    const r = redactText(frame);
    expect(r.changed).toBe(true);
    expect(r.value).toBe('42["authorization","[redacted]"]');
    expect(r.value).not.toContain('SECRET');
    expect(parseText(r.value)).toMatchObject({ type: 'event', name: 'authorization', args: [REDACTED] });
  });

  it('redacts auth events matched anywhere in the name', () => {
    expect(redactText('42["s_authorization",{"x":1}]').value).toBe('42["s_authorization","[redacted]"]');
    expect(redactText('42/ns,7["reauth",1]').value).toBe('42/ns,7["reauth","[redacted]"]');
  });

  it('redacts sensitive keys inside other events, acks and the open handshake', () => {
    expect(redactText('42["settings/store",{"chart":1,"token":"T"}]').value).toBe('42["settings/store",{"chart":1,"token":"[redacted]"}]');
    expect(redactText('431[{"email":"a@b"}]').value).toBe('431[{"email":"[redacted]"}]');
    expect(redactText('0{"sid":"x","sessionId":"y"}').value).toBe('0{"sid":"x","sessionId":"[redacted]"}');
  });

  it('returns frames with nothing to redact byte for byte', () => {
    for (const f of ['42["quotes/stream",[["A",1,2]]]', '2', '3probe', '40', '451-["quotes/stream",{"_placeholder":true,"num":0}]', '42["msg","session over"]']) {
      expect(redactText(f)).toEqual({ value: f, changed: false });
    }
  });

  it('drops the body of an unparseable frame that mentions a sensitive word', () => {
    expect(redactText('42["x",{token: bad json')).toEqual({ value: '42"[redacted]"', changed: true });
    expect(redactText('password=hunter2')).toEqual({ value: '"[redacted]"', changed: true });
  });
});

describe('redactBinary', () => {
  it('drops attachments of auth binary events whole, keeping the 0x04 prefix', () => {
    const r = redactBinary(b64('{"session":"S"}', true), 'authorization');
    expect(r.changed).toBe(true);
    const bytes = base64ToBytes(r.value)!;
    expect(bytes[0]).toBe(4);
    expect(utf8Decode(bytes.subarray(1))).toBe('"[redacted]"');
  });

  it('redacts sensitive keys inside JSON attachments', () => {
    const r = redactBinary(b64('{"balance":10,"token":"T"}'), 'profile');
    expect(text(r.value)).toBe('{"balance":10,"token":"[redacted]"}');
    const p = redactBinary(b64('[{"email":"e"}]', true), null);
    expect(Array.from(base64ToBytes(p.value)!.subarray(0, 1))).toEqual([4]);
  });

  it('leaves clean attachments untouched and redacts sensitive non-JSON or non-UTF-8 bytes', () => {
    const clean = b64('[["EURUSD_otc",1,2,0]]', true);
    expect(redactBinary(clean, 'quotes/stream')).toEqual({ value: clean, changed: false });
    expect(redactBinary(b64('token=abc'), null).changed).toBe(true);
    const msgpackish = bytesToBase64(new Uint8Array([0x81, 0xa5, ...utf8Encode('token'), 0xff]));
    expect(redactBinary(msgpackish, null).changed).toBe(true);
    const opaque = bytesToBase64(new Uint8Array([0xff, 0x00, 0x10]));
    expect(redactBinary(opaque, null)).toEqual({ value: opaque, changed: false });
  });
});

describe('redactFrame on a full binary auth exchange', () => {
  it('keeps header and attachment pairing intact after redaction', () => {
    const asm = new BinaryAssembler();
    const frames = [
      { encoding: 'text' as const, data: '451-["authorization",{"_placeholder":true,"num":0}]' },
      { encoding: 'base64' as const, data: b64('{"session":"SECRET"}', true) },
    ];
    const stored = frames.map((f) => {
      const r = redactFrame(f, asm.pendingEventName());
      asm.push(parseFrame(f));
      return r.value;
    });
    expect(stored.map((f) => f.data).join(' ')).not.toContain('SECRET');
    expect(text(stored[1]!.data)).not.toContain('SECRET');
    const replay = new BinaryAssembler();
    const events = stored.map((f) => replay.push(parseFrame(f))).filter((e) => e !== null);
    expect(events.map((e) => e.name)).toEqual(['authorization']);
  });
});

describe('redactUrl', () => {
  it('redacts sensitive query parameters only', () => {
    expect(redactUrl('wss://ws2.qxbroker.com/socket.io/?EIO=3&transport=websocket')).toBe('wss://ws2.qxbroker.com/socket.io/?EIO=3&transport=websocket');
    expect(redactUrl('wss://x.io/socket.io/?EIO=4&token=abc&sessionId=1')).toBe('wss://x.io/socket.io/?EIO=4&token=%5Bredacted%5D&sessionId=%5Bredacted%5D');
    expect(redactUrl('wss://auth.example/ws')).toBe('wss://auth.example/ws');
    expect(redactUrl('not a url with token')).toBe(REDACTED);
  });
});
