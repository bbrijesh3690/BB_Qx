import { describe, expect, it } from 'vitest';
import { bytesToBase64, utf8Encode } from './bytes';
import { attachmentJson, attachmentText, BinaryAssembler, fillPlaceholders, parseFrame, parseText, type Packet } from './socketio';

const bin = (text: string, prefix04 = false): Packet => {
  const body = utf8Encode(text);
  const bytes = prefix04 ? new Uint8Array([4, ...body]) : body;
  return parseFrame({ encoding: 'base64', data: bytesToBase64(bytes) });
};

describe('parseText: Engine.IO packets', () => {
  it('parses open with its handshake JSON', () => {
    expect(parseText('0{"sid":"abc","pingInterval":25000}')).toEqual({ type: 'open', data: { sid: 'abc', pingInterval: 25000 } });
  });

  it('parses ping and pong with optional probe data', () => {
    expect(parseText('2')).toEqual({ type: 'ping', data: '' });
    expect(parseText('3')).toEqual({ type: 'pong', data: '' });
    expect(parseText('2probe')).toEqual({ type: 'ping', data: 'probe' });
    expect(parseText('3probe')).toEqual({ type: 'pong', data: 'probe' });
  });

  it('parses close, upgrade and noop', () => {
    expect(parseText('1').type).toBe('close');
    expect(parseText('5').type).toBe('upgrade');
    expect(parseText('6').type).toBe('noop');
  });

  it('returns unknown for anything it does not recognise, without throwing', () => {
    for (const s of ['', 'x', '9', '0{bad', '4', '49', '42not json', '42{"a":1}', '42[1,2]', '45-[]', '45x-["a"]', 'hello world']) {
      expect(parseText(s).type).toBe('unknown');
    }
  });
});

describe('parseText: Socket.IO packets', () => {
  it('parses connect on the default and a named namespace', () => {
    expect(parseText('40')).toEqual({ type: 'connect', nsp: '/', data: undefined });
    expect(parseText('40{"sid":"x"}')).toEqual({ type: 'connect', nsp: '/', data: { sid: 'x' } });
    expect(parseText('40/admin,{"a":1}')).toEqual({ type: 'connect', nsp: '/admin', data: { a: 1 } });
    expect(parseText('41')).toEqual({ type: 'disconnect', nsp: '/' });
    expect(parseText('44{"message":"no"}')).toEqual({ type: 'connect_error', nsp: '/', data: { message: 'no' } });
  });

  it('parses events with and without ack id and namespace', () => {
    expect(parseText('42["tick"]')).toEqual({ type: 'event', nsp: '/', ackId: null, name: 'tick', args: [] });
    expect(parseText('42["instruments/update",{"asset":"EURUSD_otc","period":60}]')).toEqual({
      type: 'event', nsp: '/', ackId: null, name: 'instruments/update', args: [{ asset: 'EURUSD_otc', period: 60 }],
    });
    expect(parseText('4217["depth/follow","EURUSD"]')).toEqual({ type: 'event', nsp: '/', ackId: 17, name: 'depth/follow', args: ['EURUSD'] });
    expect(parseText('42/chat,3["m",1,2]')).toEqual({ type: 'event', nsp: '/chat', ackId: 3, name: 'm', args: [1, 2] });
  });

  it('parses acks', () => {
    expect(parseText('431[{"ok":true}]')).toEqual({ type: 'ack', nsp: '/', ackId: 1, args: [{ ok: true }] });
  });

  it('parses binary event headers with their attachment count', () => {
    expect(parseText('451-["quotes/stream",{"_placeholder":true,"num":0}]')).toEqual({
      type: 'binary_event', nsp: '/', ackId: null, name: 'quotes/stream', args: [{ _placeholder: true, num: 0 }], attachments: 1,
    });
    expect(parseText('452-/x,9["e",{"_placeholder":true,"num":1}]')).toMatchObject({ type: 'binary_event', nsp: '/x', ackId: 9, attachments: 2 });
    expect(parseText('461-2[{"_placeholder":true,"num":0}]')).toMatchObject({ type: 'binary_ack', ackId: 2, attachments: 1 });
  });
});

describe('parseFrame: binary frames', () => {
  it('decodes base64 into bytes and rejects malformed base64', () => {
    const p = parseFrame({ encoding: 'base64', data: bytesToBase64(new Uint8Array([4, 91, 93])) });
    expect(p.type).toBe('binary');
    expect(Array.from((p as { bytes: Uint8Array }).bytes)).toEqual([4, 91, 93]);
    expect(parseFrame({ encoding: 'base64', data: '***' }).type).toBe('unknown');
  });

  it('reads attachment JSON with or without the Engine.IO v3 0x04 prefix', () => {
    const a = bin('[["EURUSD_otc",1700000000.5,1.0712,0]]', true) as { bytes: Uint8Array };
    const b = bin('{"x":1}') as { bytes: Uint8Array };
    expect(attachmentJson(a.bytes)).toEqual([['EURUSD_otc', 1700000000.5, 1.0712, 0]]);
    expect(attachmentJson(b.bytes)).toEqual({ x: 1 });
    expect(attachmentText(new Uint8Array([0xff, 0xfe]))).toBeNull();
    expect(attachmentJson(utf8Encode('not json'))).toBeUndefined();
  });
});

describe('BinaryAssembler', () => {
  it('passes plain events straight through', () => {
    const asm = new BinaryAssembler();
    expect(asm.push(parseText('42["a",1]'))).toEqual({ name: 'a', nsp: '/', ackId: null, args: [1], attachments: 0 });
    expect(asm.push(parseText('2'))).toBeNull();
  });

  it('joins a 451- header with its binary attachment', () => {
    const asm = new BinaryAssembler();
    expect(asm.push(parseText('451-["quotes/stream",{"_placeholder":true,"num":0}]'))).toBeNull();
    expect(asm.pendingEventName()).toBe('quotes/stream');
    const ev = asm.push(bin('[["A",1,2,0]]', true));
    expect(ev?.name).toBe('quotes/stream');
    expect(ev?.attachments).toBe(1);
    expect(attachmentJson(ev!.args[0] as Uint8Array)).toEqual([['A', 1, 2, 0]]);
    expect(asm.pendingEventName()).toBeNull();
  });

  it('fills several placeholders by num, nested anywhere', () => {
    const asm = new BinaryAssembler();
    asm.push(parseText('452-["e",{"b":{"_placeholder":true,"num":1}},[{"_placeholder":true,"num":0}]]'));
    expect(asm.push(bin('"zero"'))).toBeNull();
    const ev = asm.push(bin('"one"'))!;
    const first = ev.args[0] as { b: Uint8Array };
    const second = ev.args[1] as Uint8Array[];
    expect(attachmentJson(first.b)).toBe('one');
    expect(attachmentJson(second[0]!)).toBe('zero');
  });

  it('counts orphan binaries and headers interrupted by a text packet', () => {
    const asm = new BinaryAssembler();
    expect(asm.push(bin('[]'))).toBeNull();
    expect(asm.orphanBinaries).toBe(1);
    asm.push(parseText('451-["x",{"_placeholder":true,"num":0}]'));
    expect(asm.push(parseText('42["y"]'))?.name).toBe('y');
    expect(asm.incompleteHeaders).toBe(1);
    expect(asm.push(bin('[]'))).toBeNull();
    expect(asm.orphanBinaries).toBe(2);
  });

  it('consumes binary acks without emitting an event', () => {
    const asm = new BinaryAssembler();
    asm.push(parseText('461-1[{"_placeholder":true,"num":0}]'));
    expect(asm.isAwaitingAttachments()).toBe(true);
    expect(asm.pendingEventName()).toBeNull();
    expect(asm.push(bin('{}'))).toBeNull();
    expect(asm.isAwaitingAttachments()).toBe(false);
    expect(asm.orphanBinaries).toBe(0);
  });

  it('leaves out-of-range placeholders untouched', () => {
    expect(fillPlaceholders({ _placeholder: true, num: 3 }, [])).toEqual({ _placeholder: true, num: 3 });
  });
});
