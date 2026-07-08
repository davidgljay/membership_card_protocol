import 'fake-indexeddb/auto';
import { webcrypto } from 'crypto';

// Polyfill globalThis.crypto.subtle for jsdom environment — vitest's jsdom
// doesn't provide SubtleCrypto by default, but Node's webcrypto does.
if (!globalThis.crypto.subtle) {
  Object.defineProperty(globalThis.crypto, 'subtle', {
    value: webcrypto.subtle,
    writable: false,
    configurable: false,
  });
}
