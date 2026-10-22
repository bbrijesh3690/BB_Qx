import { describe, expect, it } from 'vitest';
import { FEED_CHANNEL, type PortMessage } from '../shared/messages';
import { FeedBridge, type BridgeDeps, type PortLike } from './bridge';

class FakePort implements PortLike {
  messages: unknown[] = [];
  private listeners: (() => void)[] = [];
  broken = false;
  onDisconnect = { addListener: (fn: () => void) => void this.listeners.push(fn) };
  postMessage(m: unknown) {
    if (this.broken) throw new Error('Attempting to use a disconnected port object');
    this.messages.push(m);
  }
  disconnect() {
    this.broken = true;
    for (const fn of this.listeners) fn();
  }
}

function setup() {
  let clock = 0;
  let alive = true;
  let failConnect = false;
  const ports: FakePort[] = [];
  const timers: { at: number; fn: () => void }[] = [];
  const deps: BridgeDeps = {
    connect: () => {
      if (failConnect) throw new Error('Could not establish connection');
      const p = new FakePort();
      ports.push(p);
      return p;
    },
    alive: () => alive,
    setTimeout: (fn, ms) => timers.push({ at: clock + ms, fn }),
    now: () => clock,
  };
  const advance = (ms: number) => {
    clock += ms;
    for (const t of timers.splice(0).sort((a, b) => a.at - b.at)) {
      if (t.at <= clock) t.fn();
      else timers.push(t);
    }
  };
  return {
    bridge: new FeedBridge(deps),
    ports,
    advance,
    kill: () => (alive = false),
    setFailConnect: (v: boolean) => (failConnect = v),
  };
}

const msg = (n: number): PortMessage => ({
  type: 'tap',
  origin: 'https://qxbroker.com',
  top: true,
  msg: { channel: FEED_CHANNEL, type: 'status', sockets: n, frames: 0, errors: 0, dropped: 0 },
});

describe('FeedBridge', () => {
  it('connects lazily on the first message and forwards over the port', () => {
    const { bridge, ports } = setup();
    expect(ports).toHaveLength(0);
    bridge.send(msg(1));
    bridge.send(msg(2));
    expect(ports).toHaveLength(1);
    expect(ports[0]!.messages).toEqual([msg(1), msg(2)]);
    expect(bridge.state).toBe('connected');
  });

  it('reconnects after the worker restarts, without losing buffered messages', () => {
    const { bridge, ports, advance } = setup();
    bridge.send(msg(1));
    advance(10_000);
    ports[0]!.disconnect();
    expect(bridge.state).toBe('disconnected');
    bridge.send(msg(2));
    expect(ports).toHaveLength(2);
    expect(ports[1]!.messages).toEqual([msg(2)]);
    expect(bridge.reconnects).toBe(1);
  });

  it('treats a throwing postMessage as a disconnect and resends on the new port', () => {
    const { bridge, ports, advance } = setup();
    bridge.send(msg(1));
    advance(10_000);
    ports[0]!.broken = true;
    bridge.send(msg(2));
    expect(ports).toHaveLength(2);
    expect(ports[1]!.messages).toEqual([msg(2)]);
  });

  it('backs off when ports die young, buffering meanwhile, then delivers in order', () => {
    const { bridge, ports, advance } = setup();
    bridge.send(msg(1));
    ports[0]!.disconnect(); // died immediately
    bridge.send(msg(2));
    bridge.send(msg(3));
    expect(ports).toHaveLength(1);
    expect(bridge.buffered).toBe(2);
    advance(1_000);
    expect(ports).toHaveLength(2);
    expect(ports[1]!.messages).toEqual([msg(2), msg(3)]);
  });

  it('retries when connect throws while the extension is still alive', () => {
    const { bridge, ports, advance, setFailConnect } = setup();
    setFailConnect(true);
    bridge.send(msg(1));
    expect(bridge.state).toBe('disconnected');
    setFailConnect(false);
    advance(1_000);
    expect(ports[0]!.messages).toEqual([msg(1)]);
  });

  it('goes dead for good when the extension context is invalidated', () => {
    const { bridge, ports, kill } = setup();
    bridge.send(msg(1));
    kill();
    ports[0]!.disconnect();
    expect(bridge.state).toBe('dead');
    bridge.send(msg(2));
    expect(ports).toHaveLength(1);
    expect(bridge.dropped).toBe(1);
  });

  it('caps the buffer and counts what it drops', () => {
    const { bridge, setFailConnect } = setup();
    setFailConnect(true);
    for (let i = 0; i < 450; i++) bridge.send(msg(i));
    expect(bridge.buffered).toBe(400);
    expect(bridge.dropped).toBe(50);
  });
});
