#!/usr/bin/env node
// Generates the four keypairs a fresh press deployment needs. Run this
// yourself, in your own terminal -- the private keys it prints should go
// straight into your own secret storage (1Password, etc.), never back
// through an agent session or a committed file. See press/DEPLOYMENT.md
// and press/OPERATOR.md's First-Run Checklist.
//
// Usage (from press/, where these packages are already installed):
//   node scripts/gen-press-keys.mjs

import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { p256 } from '@noble/curves/p256';
import { x25519 } from '@noble/curves/ed25519';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// --- PRESS_MLDSA44_PRIVATE_KEY -- IPFS content-signing identity ---
const mldsa = ml_dsa44.keygen();
console.log('PRESS_MLDSA44_PRIVATE_KEY (base64url):', Buffer.from(mldsa.secretKey).toString('base64url'));
console.log('  -> public key (send this to whoever assembles PRESS_CARD_CID / approved_presses):', Buffer.from(mldsa.publicKey).toString('base64url'));
console.log();

// --- PRESS_SECP256R1_PRIVATE_KEY -- on-chain write authorization (AuthorizePress target) ---
const secpPriv = p256.utils.randomPrivateKey();
const secpPubXY = p256.getPublicKey(secpPriv, false).slice(1); // drop 0x04 prefix -> 64 bytes x||y
console.log('PRESS_SECP256R1_PRIVATE_KEY (hex):', '0x' + Buffer.from(secpPriv).toString('hex'));
console.log('  -> public key x||y (needed for the AuthorizePress governance call):', '0x' + Buffer.from(secpPubXY).toString('hex'));
console.log();

// --- PRESS_GAS_WALLET_PRIVATE_KEY -- pays gas, standard Ethereum-style account ---
const gasKey = generatePrivateKey();
const gasAccount = privateKeyToAccount(gasKey);
console.log('PRESS_GAS_WALLET_PRIVATE_KEY (hex):', gasKey);
console.log('  -> address (fund THIS with Sepolia ETH):', gasAccount.address);
console.log();

// --- PRESS_OHTTP_PRIVATE_KEY -- X25519 HPKE key for the oblivious-relay-routed endpoints ---
const ohttpPriv = crypto.getRandomValues(new Uint8Array(32));
const ohttpPub = x25519.getPublicKey(ohttpPriv);
console.log('PRESS_OHTTP_PRIVATE_KEY (base64url):', Buffer.from(ohttpPriv).toString('base64url'));
console.log('  -> public key (base64url, informational only):', Buffer.from(ohttpPub).toString('base64url'));
