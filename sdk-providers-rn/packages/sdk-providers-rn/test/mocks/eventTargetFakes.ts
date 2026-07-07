/**
 * Fake EventTarget-shaped doubles for `react-native-sse`'s EventSource and
 * global `WebSocket`, used from `jest.mock()` factories.
 *
 * Deliberately kept in their own module: Jest's mock-hoisting only exempts
 * variables prefixed with "mock" from its out-of-scope-reference check, and
 * that exemption explicitly does not cover `class` declarations referenced
 * from the same file (the hoisted `jest.mock()` call ends up relocated
 * ahead of the class declaration, hitting it mid-TDZ). Requiring a
 * separately-loaded module from inside the factory sidesteps the ordering
 * problem entirely.
 */

export class MockRNEventSource {
  static instances: MockRNEventSource[] = [];
  url: string;
  closed = false;
  #listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    MockRNEventSource.instances.push(this);
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

export class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  sent: Array<string | Uint8Array> = [];
  closed = false;
  #listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
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
