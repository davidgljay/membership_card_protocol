import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebRealtimeTransportProvider } from '../../src/RealtimeTransportProvider.js';

/**
 * jsdom implements neither `EventSource` (confirmed empirically — not
 * present as a global) nor a usable in-process `WebSocket` (jsdom's
 * WebSocket is Node's real network client, which would attempt an actual
 * connection). Both are stubbed with minimal EventTarget-based fakes so
 * these tests can exercise the provider's event wiring without a real
 * network endpoint.
 */

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  #listeners = new Map<string, Set<(event: unknown) => void>>();
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (event: unknown) => void) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type)!.add(handler);
  }

  removeEventListener(type: string, handler: (event: unknown) => void) {
    this.#listeners.get(type)?.delete(handler);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, event: unknown) {
    for (const handler of this.#listeners.get(type) ?? []) handler(event);
  }
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  sent: Array<string | Uint8Array> = [];
  closed = false;
  #listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, handler: (event: unknown) => void) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type)!.add(handler);
  }

  send(data: string | Uint8Array) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, event: unknown) {
    for (const handler of this.#listeners.get(type) ?? []) handler(event);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
  FakeWebSocket.instances = [];
});

describe('WebRealtimeTransportProvider — SSE', () => {
  it('subscribeSSE forwards message data to onMessage', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const provider = new WebRealtimeTransportProvider();
    const messages: string[] = [];
    provider.subscribeSSE('https://example.com/sse', (data) => messages.push(data), () => {});

    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe('https://example.com/sse');
    source.emit('message', { data: 'hello' });

    expect(messages).toEqual(['hello']);
  });

  it('subscribeSSE forwards error events to onError', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const provider = new WebRealtimeTransportProvider();
    const errors: unknown[] = [];
    provider.subscribeSSE('https://example.com/sse', () => {}, (err) => errors.push(err));

    FakeEventSource.instances[0]!.emit('error', { type: 'error' });
    expect(errors).toHaveLength(1);
  });

  it('the returned unsubscribe function closes the underlying connection', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const provider = new WebRealtimeTransportProvider();
    const unsubscribe = provider.subscribeSSE('https://example.com/sse', () => {}, () => {});

    unsubscribe();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
  });
});

describe('WebRealtimeTransportProvider — WebSocket', () => {
  it('send() forwards to the underlying socket', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const provider = new WebRealtimeTransportProvider();
    const handle = provider.connectWebSocket('wss://example.com/ws');

    handle.send('ping');
    expect(FakeWebSocket.instances[0]!.sent).toEqual(['ping']);
  });

  it('onMessage/onClose/onError forward the underlying socket events', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const provider = new WebRealtimeTransportProvider();
    const handle = provider.connectWebSocket('wss://example.com/ws');
    const socket = FakeWebSocket.instances[0]!;

    const messages: unknown[] = [];
    handle.onMessage((data) => messages.push(data));
    socket.emit('message', { data: 'pong' });
    expect(messages).toEqual(['pong']);

    let closeArgs: [number, string] | undefined;
    handle.onClose((code, reason) => (closeArgs = [code, reason]));
    socket.emit('close', { code: 1000, reason: 'done' });
    expect(closeArgs).toEqual([1000, 'done']);

    let errorSeen = false;
    handle.onError(() => (errorSeen = true));
    socket.emit('error', {});
    expect(errorSeen).toBe(true);
  });

  it('close() closes the underlying socket', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const provider = new WebRealtimeTransportProvider();
    const handle = provider.connectWebSocket('wss://example.com/ws');

    handle.close();
    expect(FakeWebSocket.instances[0]!.closed).toBe(true);
  });
});
