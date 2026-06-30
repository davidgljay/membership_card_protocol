import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { keccak_256 } from '@noble/hashes/sha3';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const TARGET_UUIDS = Number(process.env.UUID_COUNT ?? 60000);

const ch = await (await fetch(`${BASE}/accounts/challenge`, { method: 'POST' })).json();
const seed = crypto.getRandomValues(new Uint8Array(32));
const keys = ml_dsa44.keygen(seed);
const sig = ml_dsa44.sign(Buffer.from(ch.challenge, 'base64url'), keys.secretKey);
const cardHash = '0x' + Buffer.from(keccak_256(keys.publicKey)).toString('hex');

await fetch(`${BASE}/accounts`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    challenge: ch.challenge,
    signature: Buffer.from(sig).toString('base64url'),
    card_hash: cardHash,
    master_pubkey: Buffer.from(keys.publicKey).toString('base64url'),
    webauthn_credential_id: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url'),
    webauthn_public_key: Buffer.from('fake-cose-public-key').toString('base64url'),
    encrypted_keyring_blob: Buffer.from('load-test-blob').toString('base64url'),
  }),
});

const subcardHash = '0xsubcard-loadtest-' + crypto.randomUUID();

let registered = 0;
while (registered < TARGET_UUIDS) {
  const batchSize = Math.min(100, TARGET_UUIDS - registered);
  const uuids = Array.from({ length: batchSize }, () => crypto.randomUUID());
  const res = await fetch(`${BASE}/cards/${cardHash}/subcards/${subcardHash}/uuids`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uuids }),
  });
  if (!res.ok) {
    console.error('UUID registration batch failed:', res.status, await res.text());
    process.exit(1);
  }
  registered += batchSize;
}

console.log(JSON.stringify({ card_hash: cardHash, subcard_hash: subcardHash, uuids_registered: registered }));
