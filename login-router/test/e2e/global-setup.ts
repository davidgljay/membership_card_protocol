// Builds a test copy of the router (dist-test/) with two certified test
// wallets baked in, and writes their signed registration tokens to
// test/e2e/.fixtures/tokens.json for the specs.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { canonicalize } from '@membership-card-protocol/verifier';

export const ROUTER_ORIGIN = 'http://localhost:8911';
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64url');

export default async function globalSetup(): Promise<void> {
  const wallets = ['a', 'b', 'rogue'].map((name, i) => {
    const k = ml_dsa44.keygen(new Uint8Array(32).fill(0x40 + i));
    return { name, k, app_card: `card-${name}`, handler_url: `https://wallet-${name}.test/login` };
  });
  const certified = wallets
    .filter((w) => w.name !== 'rogue')
    .map((w) => ({ app_card: w.app_card, app_card_pubkey: b64(w.k.publicKey), name: `Wallet ${w.name.toUpperCase()}`, handler_url: w.handler_url, platforms: ['web'] }));
  const tokens: Record<string, unknown> = {};
  for (const w of wallets) {
    const body = {
      app_card: w.app_card, app_card_pubkey: b64(w.k.publicKey), expires_at: '2099-01-01T00:00:00Z', handler_url: w.handler_url,
      issued_at: '2098-06-01T00:00:00Z', name: `Wallet ${w.name.toUpperCase()}`, router_origin: ROUTER_ORIGIN, version: '1',
    };
    tokens[w.name] = b64(canonicalize({ token: body, signature: b64(ml_dsa44.sign(canonicalize(body), w.k.secretKey)) }));
  }
  mkdirSync('test/e2e/.fixtures', { recursive: true });
  writeFileSync('test/e2e/.fixtures/wallets.json', JSON.stringify(certified));
  writeFileSync('test/e2e/.fixtures/tokens.json', JSON.stringify(tokens));
  execFileSync('node', ['scripts/build.mjs'], {
    stdio: 'inherit',
    env: { ...process.env, ROUTER_OUTDIR: 'dist-test', ROUTER_WALLETS: 'test/e2e/.fixtures/wallets.json' },
  });
}
