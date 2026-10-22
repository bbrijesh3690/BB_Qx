// Content script -> service worker forwarding over a long-lived port, with reconnect.
//
// MV3 service workers stop when idle and restart on the next event; the port disconnects when
// that happens. The bridge reconnects on the next message (which wakes the worker) and buffers a
// bounded number of messages meanwhile. When the extension itself is reloaded the content script's
// context is invalidated for good: the bridge goes 'dead' and the panel says so.

import type { PortMessage } from '../shared/messages';

const MAX_BUFFER = 400; // TUNABLE: ~100 s of 250 ms batches held while the worker restarts
const RETRY_MIN_MS = 1_000; // TUNABLE: first reconnect delay after a port that died young
const RETRY_MAX_MS = 30_000; // TUNABLE: cap on the reconnect backoff
const HEALTHY_MS = 5_000; // TUNABLE: a port that lived this long resets the backoff

export interface PortLike {
  postMessage(msg: unknown): void;
  onDisconnect: { addListener(fn: () => void): void };
}

export interface BridgeDeps {
  /** chrome.runtime.connect; may throw once the extension context is invalidated. */
  connect(): PortLike;
  /** False once the extension has been reloaded or removed (chrome.runtime.id is gone). */
  alive(): boolean;
  setTimeout(fn: () => void, ms: number): unknown;
  now(): number;
}

export type BridgeState = 'connected' | 'disconnected' | 'dead';

export class FeedBridge {
  state: BridgeState = 'disconnected';
  sent = 0;
  dropped = 0;
  reconnects = 0;
  private port: PortLike | null = null;
  private buffer: PortMessage[] = [];
  private connectedAt = 0;
  private everConnected = false;
  private backoffMs = 0;
  private retryAt = 0;
  private retryScheduled = false;

  constructor(private readonly deps: BridgeDeps) {}

  send(msg: PortMessage): void {
    if (this.state === 'dead') {
      this.dropped++;
      return;
    }
    if (this.port && this.trySend(msg)) return;
    this.enqueue(msg);
    if (this.deps.now() >= this.retryAt) this.connect();
    else this.scheduleRetry();
  }

  private trySend(msg: PortMessage): boolean {
    try {
      this.port!.postMessage(msg);
      this.sent++;
      return true;
    } catch {
      this.onDisconnect(this.port!);
      return false;
    }
  }

  private enqueue(msg: PortMessage): void {
    this.buffer.push(msg);
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer.shift();
      this.dropped++;
    }
  }

  private connect(): void {
    if (!this.deps.alive()) {
      this.die();
      return;
    }
    let port: PortLike;
    try {
      port = this.deps.connect();
    } catch {
      if (!this.deps.alive()) this.die();
      else this.backOff();
      return;
    }
    if (this.everConnected) this.reconnects++;
    this.everConnected = true;
    this.port = port;
    this.state = 'connected';
    this.connectedAt = this.deps.now();
    port.onDisconnect.addListener(() => this.onDisconnect(port));
    const pending = this.buffer;
    this.buffer = [];
    for (const m of pending) {
      if (!this.port || !this.trySend(m)) {
        this.enqueue(m);
      }
    }
    if (!this.port && this.buffer.length > 0) this.scheduleRetry();
  }

  private onDisconnect(port: PortLike): void {
    if (this.port !== port) return;
    this.port = null;
    if (!this.deps.alive()) {
      this.die();
      return;
    }
    this.state = 'disconnected';
    const lived = this.deps.now() - this.connectedAt;
    if (lived >= HEALTHY_MS) {
      this.backoffMs = 0;
      this.retryAt = 0;
    } else {
      this.backOff();
    }
    if (this.buffer.length > 0) this.scheduleRetry();
  }

  private backOff(): void {
    this.backoffMs = Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, this.backoffMs * 2));
    this.retryAt = this.deps.now() + this.backoffMs;
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryScheduled) return;
    this.retryScheduled = true;
    const wait = Math.max(0, this.retryAt - this.deps.now());
    this.deps.setTimeout(() => {
      this.retryScheduled = false;
      if (this.state !== 'connected' && this.state !== 'dead') this.connect();
    }, wait);
  }

  private die(): void {
    this.state = 'dead';
    this.port = null;
    this.dropped += this.buffer.length;
    this.buffer = [];
  }

  get buffered(): number {
    return this.buffer.length;
  }
}
