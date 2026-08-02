#!/usr/bin/env node
// Pins the shared dev-tests permissive policy document to your real
// Filebase bucket, mirroring press/src/ipfs/filebase.ts's own
// pinToIPFS exactly (PutObject, then HeadObject to read the
// Filebase-assigned CID from the "cid" metadata key) -- so the result is
// guaranteed fetchable the same way press itself will fetch it at
// issuance time.
//
// Run this yourself, in your own terminal, with your Filebase credentials
// as env vars -- same reasoning as the key-generation scripts: this
// script needs real credentials, so it should never pass through an
// agent session.
//
// Usage (from press/, where @aws-sdk/client-s3 is already installed):
//   export FILEBASE_KEY=...
//   export FILEBASE_SECRET=...
//   export FILEBASE_BUCKET=...
//   node scripts/pin-dev-policy.mjs
//
// Prints the resulting policy CID (this is DEV_TESTS_POLICY_ID) and its
// keccak256-derived on-chain address (DEV_TESTS_POLICY_ADDRESS) -- see
// dev-tests/.env.example and dev-tests/README.md's "Dev governance
// prerequisite".

import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { keccak_256 } from '@noble/hashes/sha3.js';

const FILEBASE_KEY = process.env.FILEBASE_KEY;
const FILEBASE_SECRET = process.env.FILEBASE_SECRET;
const FILEBASE_BUCKET = process.env.FILEBASE_BUCKET;
const FILEBASE_ENDPOINT = process.env.FILEBASE_ENDPOINT ?? 'https://s3.filebase.com';
const FILEBASE_REGION = process.env.FILEBASE_REGION ?? 'us-east-1';
const FILEBASE_GATEWAY_URL = process.env.FILEBASE_GATEWAY_URL ?? 'https://ipfs.filebase.io';

// The press's own PRESS_CARD_CID -- never independently validated by press
// or on-chain (only ever compared as a plain string against this policy's
// approved_presses list), so a clearly-labeled placeholder is fine. Must
// match whatever you set PRESS_CARD_CID to in press's deploy config.
const PRESS_CARD_CID_PLACEHOLDER = 'card-protocol-dev-press-placeholder';

for (const [name, val] of Object.entries({ FILEBASE_KEY, FILEBASE_SECRET, FILEBASE_BUCKET })) {
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}

const policyDocument = {
  policy_id: 'card-protocol-dev-testing-policy',
  field_definitions: {
    display_name: { type: 'string', required: false },
  },
  approved_presses: [PRESS_CARD_CID_PLACEHOLDER],
  allow_open_offers: true,
};

const content = new TextEncoder().encode(JSON.stringify(policyDocument));

const s3 = new S3Client({
  endpoint: FILEBASE_ENDPOINT,
  region: FILEBASE_REGION,
  credentials: { accessKeyId: FILEBASE_KEY, secretAccessKey: FILEBASE_SECRET },
  forcePathStyle: true,
});

const keyHash = Buffer.from(await crypto.subtle.digest('SHA-256', content)).toString('hex');
const key = `press/${keyHash.slice(0, 32)}`;

await s3.send(new PutObjectCommand({
  Bucket: FILEBASE_BUCKET,
  Key: key,
  Body: content,
  ContentType: 'application/octet-stream',
}));

const head = await s3.send(new HeadObjectCommand({ Bucket: FILEBASE_BUCKET, Key: key }));
const cid = head.Metadata?.['cid'];
if (!cid) {
  console.error('Filebase did not return an IPFS CID (no "cid" metadata on the uploaded object).');
  process.exit(1);
}

// Validate by re-fetching, same P-10 guard press itself applies.
const fetchRes = await fetch(`${FILEBASE_GATEWAY_URL}/ipfs/${cid}`);
if (!fetchRes.ok) {
  console.error(`CID validation fetch failed: HTTP ${fetchRes.status}`);
  process.exit(1);
}
const fetched = new Uint8Array(await fetchRes.arrayBuffer());
const matches = fetched.length === content.length && fetched.every((b, i) => b === content[i]);
if (!matches) {
  console.error('P-10: fetched bytes differ from uploaded bytes -- do not use this CID.');
  process.exit(1);
}

// keccak256 of the CID string, not the document bytes -- matches
// press's own derivation (src/handlers/issue.ts, open-offer.ts:
// keccak256(new TextEncoder().encode(offer.policy_id))), which is the
// address press will actually look up at issuance time. Confirmed live:
// an earlier keccak256(content)-based registration caused every
// registerCard call to revert with UnrecognizedPolicy() because press
// computed a different address than what was registered on-chain.
const policyAddress = '0x' + Buffer.from(keccak_256(new TextEncoder().encode(cid))).toString('hex');

console.log('Pinned and verified.');
console.log();
console.log('DEV_TESTS_POLICY_ID (the CID):', cid);
console.log('DEV_TESTS_POLICY_ADDRESS (keccak256 of the pinned bytes):', policyAddress);
console.log();
console.log('PRESS_CARD_CID to use in press config:', PRESS_CARD_CID_PLACEHOLDER);
console.log('(this exact string is already in the pinned policy\'s approved_presses list)');
