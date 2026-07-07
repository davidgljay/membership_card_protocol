// No __esModule/default wrapping: react-native-sse's real module is
// `module.exports = EventSource` (a bare CJS export, not a named `default`
// property), so the mock must match that shape for Babel's
// _interopRequireDefault to unwrap it the same way at import time.
jest.mock('react-native-sse', () => require('../mocks/eventTargetFakes.js').MockRNEventSource);

import { MockRNEventSource, MockWebSocket } from '../mocks/eventTargetFakes.js';
import { RNRealtimeTransportProvider } from '../../src/RealtimeTransportProvider.js';

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  MockRNEventSource.instances = [];
  MockWebSocket.instances = [];
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
});

afterAll(() => {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
});

describe('RNRealtimeTransportProvider — SSE (react-native-sse)', () => {
  it('subscribeSSE forwards non-null message data to onMessage', () => {
    const provider = new RNRealtimeTransportProvider();
    const messages: string[] = [];
    provider.subscribeSSE('https://example.com/sse', (data) => messages.push(data), () => {});

    const source = MockRNEventSource.instances[0]!;
    expect(source.url).toBe('https://example.com/sse');
    source.emit('message', { data: 'hello' });
    source.emit('message', { data: null });

    expect(messages).toEqual(['hello']);
  });

  it('the returned unsubscribe function closes the underlying connection', () => {
    const provider = new RNRealtimeTransportProvider();
    const unsubscribe = provider.subscribeSSE('https://example.com/sse', () => {}, () => {});
    unsubscribe();
    expect(MockRNEventSource.instances[0]!.closed).toBe(true);
  });
});

describe('RNRealtimeTransportProvider — WebSocket', () => {
  it('send()/close() forward to the underlying socket, and onMessage/onClose/onError forward events', () => {
    const provider = new RNRealtimeTransportProvider();
    const handle = provider.connectWebSocket('wss://example.com/ws');
    const socket = MockWebSocket.instances[0]!;

    handle.send('ping');
    expect(socket.sent).toEqual(['ping']);

    const messages: unknown[] = [];
    handle.onMessage((data) => messages.push(data));
    socket.emit('message', { data: 'pong' });
    expect(messages).toEqual(['pong']);

    let closeArgs: [number, string] | undefined;
    handle.onClose((code, reason) => (closeArgs = [code, reason]));
    socket.emit('close', { code: 1000, reason: 'done' });
    expect(closeArgs).toEqual([1000, 'done']);

    handle.close();
    expect(socket.closed).toBe(true);
  });
});
