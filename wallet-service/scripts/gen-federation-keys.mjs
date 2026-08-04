#!/usr/bin/env node
// Generates this wallet-service instance's federation identity keypair
// (ML-DSA-44) -- see .env.example's Federation section and
// implementation-plan.md's §Step 4.0/4.1.
//
// Run this yourself, in your own terminal -- same reasoning as
// press/scripts/gen-press-keys.mjs: this generates real private key
// material, so it should never pass through an agent session.
//
// Usage (from wallet-service/, where @noble/post-quantum is installed):
//   node scripts/gen-federation-keys.mjs
//
// Prints WALLET_SERVICE_ID (public, safe to record) and
// WALLET_SERVICE_PRIVATE_KEY (secret -- goes straight into your .env.dev,
// never anywhere else).

import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

const seed = crypto.getRandomValues(new Uint8Array(32));
const keys = ml_dsa44.keygen(seed);

const privateKeyB64url = Buffer.from(keys.secretKey).toString('base64url');
const walletServiceId = '0x' + Buffer.from(keccak_256(keys.publicKey)).toString('hex');

console.log('WALLET_SERVICE_ID (public, safe to record):');
console.log(walletServiceId);
console.log();
console.log('WALLET_SERVICE_PRIVATE_KEY (secret -- .env.dev only, never commit):');
console.log(privateKeyB64url);
