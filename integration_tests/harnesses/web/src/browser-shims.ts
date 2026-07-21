/**
 * Browser polyfills for Node globals several dependencies assume are
 * present (`Buffer.from(...)`, `process.env`) even though nothing on this
 * page's actual code path needs real Node — same category of gap as the
 * `node:crypto` fixes documented in `phase-1-environment-notes.md`, but
 * this one has a drop-in browser equivalent (unlike `node:crypto`'s
 * cipher/hash primitives, which needed real source changes to WebCrypto),
 * so it's handled here at the bundler level instead of touching every
 * dependency's source. Injected first via `build.mjs`'s esbuild `inject`
 * option, before any other module evaluates.
 */
import { Buffer } from 'buffer';

declare global {
  // eslint-disable-next-line no-var
  var Buffer: typeof import('buffer').Buffer;
  // eslint-disable-next-line no-var
  var process: { env: Record<string, string | undefined> };
}

if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = Buffer;
}
if (typeof globalThis.process === 'undefined') {
  globalThis.process = { env: {} };
}

export {};
