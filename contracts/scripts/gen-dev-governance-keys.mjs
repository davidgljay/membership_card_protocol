#!/usr/bin/env node
// Generates fresh secp256r1 keypairs for rotating a dev-tests-owned
// governance body keyset (see plans/deployment/phase-3-summary.md's
// "governance-authority blocker"). Run this yourself, in your own
// terminal -- the private keys it prints should go straight into your
// own secret storage (1Password, etc.), never back through an agent
// session or a committed file.
//
// Usage (from contracts/, or anywhere with @noble/curves installed,
// e.g. `cd app-sdk/packages/app-sdk && node ../../../contracts/scripts/gen-dev-governance-keys.mjs`):
//   node gen-dev-governance-keys.mjs

import { p256 } from '@noble/curves/p256.js';

function genKeypair(label) {
  const priv = p256.utils.randomPrivateKey();
  const pubXY = p256.getPublicKey(priv, false).slice(1); // drop 0x04 prefix -> 64 bytes x||y
  return {
    label,
    privateKeyHex: '0x' + Buffer.from(priv).toString('hex'),
    publicKeyXYHex: '0x' + Buffer.from(pubXY).toString('hex'),
  };
}

const bodies = {
  // Body 0 -- RootPolicyBody. Governs RegisterPolicy on the Sepolia dev
  // deployment. 3 keys, quorum 2 (contract minimum: MIN_GOVERNANCE_KEYS=3,
  // quorum must exceed key_count/2).
  body0_RootPolicyBody: [genKeypair('body0-key-1'), genKeypair('body0-key-2'), genKeypair('body0-key-3')],
  // Body 1 -- PressRegistryBody. Governs AuthorizePress only. Rotated so
  // dev-tests can issue cards under freshly-authorized policies at
  // test-run time (needed by log_auditing.spec.ts) -- this is now the
  // main use case for this dev deployment, so it's in scope alongside
  // Body 0/2 rather than staying pinned to the original deployer key.
  body1_PressRegistryBody: [genKeypair('body1-key-1'), genKeypair('body1-key-2'), genKeypair('body1-key-3')],
  // Body 2 -- DnsGovernanceBody. Governs RegisterDomain/DeregisterDomain/
  // SetDnsGovernancePolicyAddress only -- cannot be used for RegisterPolicy
  // or AuthorizePress (enforced on-chain, see write_gate.rs's per-body
  // quorum check).
  body2_DnsGovernanceBody: [genKeypair('body2-key-1'), genKeypair('body2-key-2'), genKeypair('body2-key-3')],
};

console.log(JSON.stringify(bodies, null, 2));
console.log('\n--- Public keys only (safe to share/paste back for the rotation payload) ---');
for (const [body, keys] of Object.entries(bodies)) {
  console.log(`${body}:`);
  for (const k of keys) console.log(`  ${k.label}: ${k.publicKeyXYHex}`);
}
