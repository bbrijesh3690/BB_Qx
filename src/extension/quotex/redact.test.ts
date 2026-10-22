import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64, utf8Decode, utf8Encode } from './bytes';
import { ACCOUNT_DATA, MARKET_EVENTS, REDACTED, redactBinary, redactDeep, redactFrame, redactText, redactUrl } from './redact';
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

  it('redacts sensitive keys inside market events, acks and the open handshake', () => {
    expect(redactText('42["instruments/update",{"asset":"A","token":"T"}]').value).toBe('42["instruments/update",{"asset":"A","token":"[redacted]"}]');
    expect(redactText('431[{"email":"a@b"}]').value).toBe('431[{"email":"[redacted]"}]');
    expect(redactText('0{"sid":"x","sessionId":"y"}').value).toBe('0{"sid":"[redacted]","sessionId":"[redacted]"}');
  });

  it('returns market frames with nothing to redact byte for byte', () => {
    for (const f of ['42["quotes/stream",[["A",1,2]]]', '2', '3probe', '40', '451-["quotes/stream",{"_placeholder":true,"num":0}]', '42["tick"]', '42["depth/follow","BRLUSD_otc"]']) {
      expect(redactText(f)).toEqual({ value: f, changed: false });
    }
  });

  it('drops the body of an unparseable frame that mentions a sensitive word', () => {
    expect(redactText('42["quotes/stream",{token: bad json')).toEqual({ value: '42"[redacted]"', changed: true });
    expect(redactText('password=hunter2')).toEqual({ value: '"[redacted]"', changed: true });
  });

  // Shapes from the first real recording (2026-10-22), values made up.
  it('keeps only the name of account events: trades, balances, settings', () => {
    const orders = '42["orders/open",{"asset":"BRLUSD_otc","amount":1.5,"time":15,"action":"call","isDemo":0,"requestId":1}]';
    expect(redactText(orders)).toEqual({ value: `42["orders/open","${ACCOUNT_DATA}"]`, changed: true });
    expect(redactText('42["settings/store",{"chartId":"graph"}]').value).toBe(`42["settings/store","${ACCOUNT_DATA}"]`);
    expect(parseText(redactText(orders).value)).toMatchObject({ type: 'event', name: 'orders/open', args: [ACCOUNT_DATA] });
  });

  it('lists exactly the market events the decoder and schema tools need', () => {
    expect([...MARKET_EVENTS].sort()).toEqual([
      'chart_notification/get', 'depth/change', 'depth/follow', 'depth/unfollow', 'history/list/v2', 'history/load',
      'instruments/list', 'instruments/update', 's_chart_notification/get', 'tick', 'quotes/stream',
    ].sort());
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

  it('drops attachments of account events whole and keeps their 0x04 prefix', () => {
    const r = redactBinary(b64('{"uid":49,"isDemo":0,"balance":100.5}', true), 's_balance');
    expect(text(r.value).slice(1)).toBe(JSON.stringify(ACCOUNT_DATA));
    expect(Array.from(base64ToBytes(r.value)!.subarray(0, 1))).toEqual([4]);
  });

  it('redacts sensitive keys inside JSON attachments of market events', () => {
    const r = redactBinary(b64('{"asset":"A","token":"T"}'), 'history/load');
    expect(text(r.value)).toBe('{"asset":"A","token":"[redacted]"}');
    const p = redactBinary(b64('[{"email":"e"}]', true), 'quotes/stream');
    expect(Array.from(base64ToBytes(p.value)!.subarray(0, 1))).toEqual([4]);
  });

  it('leaves clean attachments untouched and redacts sensitive non-JSON or non-UTF-8 bytes', () => {
    const clean = b64('[["EURUSD_otc",1,2,0]]', true);
    expect(redactBinary(clean, 'quotes/stream')).toEqual({ value: clean, changed: false });
    expect(redactBinary(b64('token=abc'), 'quotes/stream').changed).toBe(true);
    const msgpackish = bytesToBase64(new Uint8Array([0x81, 0xa5, ...utf8Encode('token'), 0xff]));
    expect(redactBinary(msgpackish, 'quotes/stream').changed).toBe(true);
    const opaque = bytesToBase64(new Uint8Array([0xff, 0x00, 0x10]));
    expect(redactBinary(opaque, 'quotes/stream')).toEqual({ value: opaque, changed: false });
  });

  it('drops an attachment that arrives with no header in front of it', () => {
    const r = redactBinary(b64('[{"id":"x","uid":1,"amount":1.5}]', true), null);
    expect(r.changed).toBe(true);
    expect(text(r.value).slice(1)).toBe('"[redacted: unpaired attachment]"');
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

describe('redactFrame on a binary account event', () => {
  it('drops the balance attachment but keeps the event countable on replay', () => {
    const asm = new BinaryAssembler();
    const frames = [
      { encoding: 'text' as const, data: '451-["s_balance",{"_placeholder":true,"num":0}]' },
      { encoding: 'base64' as const, data: b64('{"uid":12345678,"isDemo":0,"balance":100.5}', true) },
    ];
    const stored = frames.map((f) => {
      const r = redactFrame(f, asm.pendingEventName());
      asm.push(parseFrame(f));
      return r.value;
    });
    expect(stored.map((f) => (f.encoding === 'text' ? f.data : text(f.data))).join(' ')).not.toMatch(/12345678|100\.5/);
    const replay = new BinaryAssembler();
    const events = stored.map((f) => replay.push(parseFrame(f))).filter((e) => e !== null);
    expect(events.map((e) => e.name)).toEqual(['s_balance']);
  });
});
