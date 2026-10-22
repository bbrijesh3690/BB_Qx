import { describe, expect, it, vi } from 'vitest';
import { base64ToBytes } from './quotex/bytes';
import { FEED_CHANNEL, isTapMessage, type TapBatch } from './shared/messages';
import { installFeedTap, type TapHost } from './tap';

type Listener = (ev: unknown) => void;

function makeFakeSocketClass() {
  const sendCalls: { self: unknown; args: unknown[] }[] = [];
  class FakeWebSocket {
    static readonly OPEN = 1;
    readonly url: string;
    readonly protocols: unknown;
    readonly listeners = new Map<string, Listener[]>();
    shouldThrow = false;
    constructor(url: string, protocols?: unknown) {
      this.url = url;
      this.protocols = protocols;
    }
    addEventListener(type: string, fn: Listener) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
    }
    send(...args: unknown[]) {
      sendCalls.push({ self: this, args });
      if (this.shouldThrow) throw new Error('InvalidStateError');
      return 'sent';
    }
    emit(type: string, ev: unknown) {
      for (const fn of this.listeners.get(type) ?? []) fn(ev);
    }
  }
  return { FakeWebSocket, sendCalls };
}

function setup() {
  const { FakeWebSocket, sendCalls } = makeFakeSocketClass();
  const posted: unknown[] = [];
  const intervals: (() => void)[] = [];
  let clock = 1000;
  const host: TapHost & { WebSocket: typeof FakeWebSocket } = {
    WebSocket: FakeWebSocket,
    postMessage: (m: unknown, origin: string) => {
      expect(origin).toBe('*');
      posted.push(m);
    },
    setInterval: (fn: () => void) => {
      intervals.push(fn);
      return intervals.length;
    },
  };
  const handle = installFeedTap(host, () => clock)!;
  const batches = () => posted.filter((m): m is TapBatch => (m as TapBatch).type === 'batch');
  return { host, handle, FakeWebSocket, sendCalls, posted, batches, intervals, tick: (ms: number) => (clock += ms) };
}

describe('installFeedTap', () => {
  it('wraps the constructor transparently', () => {
    const { host, FakeWebSocket } = setup();
    const ws = new host.WebSocket('wss://ws2.example/socket.io/?EIO=3', ['p']);
    expect(ws).toBeInstanceOf(FakeWebSocket);
    expect(ws).toBeInstanceOf(host.WebSocket);
    expect(ws.url).toBe('wss://ws2.example/socket.io/?EIO=3');
    expect(ws.protocols).toEqual(['p']);
    expect(host.WebSocket.OPEN).toBe(1);
    class Sub extends host.WebSocket {}
    expect(new Sub('wss://sub')).toBeInstanceOf(FakeWebSocket);
  });

  it('calls the original send with the same this and arguments, and returns its result', () => {
    const { host, sendCalls } = setup();
    const ws = new host.WebSocket('wss://x');
    const buf = new Uint8Array([1, 2]);
    expect(ws.send('42["a"]', buf)).toBe('sent');
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]!.self).toBe(ws);
    expect(sendCalls[0]!.args[0]).toBe('42["a"]');
    expect(sendCalls[0]!.args[1]).toBe(buf);
  });

  it("propagates the original send's exception unchanged and records nothing", () => {
    const { host, handle, batches } = setup();
    const ws = new host.WebSocket('wss://x');
    ws.shouldThrow = true;
    expect(() => ws.send('x')).toThrow('InvalidStateError');
    handle.flush();
    expect(batches()).toEqual([]);
  });

  it('records incoming and outgoing frames in order with socket id, url, direction and local time', () => {
    const { host, handle, batches, tick } = setup();
    const a = new host.WebSocket('wss://a');
    const b = new host.WebSocket('wss://b');
    a.send('42["authorization",{}]');
    tick(5);
    a.emit('message', { data: '451-["quotes/stream",{"_placeholder":true,"num":0}]' });
    a.emit('message', { data: new Uint8Array([4, 91, 93]).buffer });
    b.emit('message', { data: '2' });
    handle.flush();
    const [batch] = batches();
    expect(isTapMessage(batch)).toBe(true);
    expect(batch!.channel).toBe(FEED_CHANNEL);
    expect(batch!.frames.map((f) => [f.sid, f.url, f.dir, f.enc, f.t])).toEqual([
      [1, 'wss://a', 'out', 'text', 1000],
      [1, 'wss://a', 'in', 'text', 1005],
      [1, 'wss://a', 'in', 'base64', 1005],
      [2, 'wss://b', 'in', 'text', 1005],
    ]);
    expect(Array.from(base64ToBytes(batch!.frames[2]!.data)!)).toEqual([4, 91, 93]);
    handle.flush();
    expect(batches()).toHaveLength(1);
  });

  it('converts typed-array views by their visible bytes only', () => {
    const { host, handle, batches } = setup();
    const ws = new host.WebSocket('wss://a');
    const view = new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4);
    ws.send(view);
    handle.flush();
    expect(Array.from(base64ToBytes(batches()[0]!.frames[0]!.data)!)).toEqual([1, 2, 3]);
  });

  it('reads Blobs asynchronously without reordering frames', async () => {
    const { host, handle, batches } = setup();
    const ws = new host.WebSocket('wss://a');
    ws.emit('message', { data: new Blob([new Uint8Array([4, 1])]) });
    ws.emit('message', { data: 'after' });
    handle.flush();
    expect(batches()).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 10));
    handle.flush();
    expect(batches()[0]!.frames.map((f) => f.enc)).toEqual(['base64', 'text']);
  });

  it('gives up on a Blob read that never finishes and moves on', () => {
    const { host, handle, batches, tick } = setup();
    const ws = new host.WebSocket('wss://a');
    const stuck = { arrayBuffer: () => new Promise(() => {}) };
    Object.defineProperty(stuck, Symbol.toStringTag, { value: 'Blob' });
    ws.emit('message', { data: stuck });
    ws.emit('message', { data: 'next' });
    handle.flush();
    expect(batches()).toHaveLength(0);
    tick(6000);
    handle.flush();
    expect(batches()[0]!.frames.map((f) => f.data)).toEqual(['next']);
    expect(handle.status().dropped).toBe(1);
  });

  it('swallows its own errors and still lets the page see every event', () => {
    const { host, handle } = setup();
    const ws = new host.WebSocket('wss://a');
    const pageListener = vi.fn();
    ws.addEventListener('message', pageListener);
    const evil = {};
    Object.defineProperty(evil, 'data', { get: () => { throw new Error('boom'); } });
    expect(() => ws.emit('message', evil)).not.toThrow();
    expect(pageListener).toHaveBeenCalledWith(evil);
    expect(handle.status().errors).toBe(1);
  });

  it('installs once per host and reports status', () => {
    const { host, handle, posted, intervals } = setup();
    expect(installFeedTap(host)).toBe(handle);
    expect(intervals).toHaveLength(2);
    const ws = new host.WebSocket('wss://a');
    ws.emit('message', { data: 'x' });
    expect(handle.status()).toEqual({ sockets: 1, frames: 1, errors: 0, dropped: 0 });
    ws.emit('close', {});
    expect(handle.status().sockets).toBe(0);
    expect(posted[0]).toEqual({ channel: FEED_CHANNEL, type: 'status', sockets: 0, frames: 0, errors: 0, dropped: 0 });
  });

  it('does nothing when the host has no WebSocket', () => {
    expect(installFeedTap({ WebSocket: undefined, postMessage: () => {}, setInterval: () => 0 })).toBeNull();
  });
});

describe('isTapMessage', () => {
  it('accepts well-formed batches and status messages only', () => {
    const frame = { sid: 1, url: 'u', dir: 'in', enc: 'text', data: 'd', t: 1 };
    expect(isTapMessage({ channel: FEED_CHANNEL, type: 'batch', frames: [frame] })).toBe(true);
    expect(isTapMessage({ channel: FEED_CHANNEL, type: 'status', sockets: 1, frames: 2, errors: 0, dropped: 0 })).toBe(true);
    expect(isTapMessage({ channel: 'other', type: 'batch', frames: [] })).toBe(false);
    expect(isTapMessage({ channel: FEED_CHANNEL, type: 'batch', frames: [{ ...frame, dir: 'sideways' }] })).toBe(false);
    expect(isTapMessage({ channel: FEED_CHANNEL, type: 'status', sockets: '1' })).toBe(false);
    expect(isTapMessage(null)).toBe(false);
    expect(isTapMessage('x')).toBe(false);
  });
});
