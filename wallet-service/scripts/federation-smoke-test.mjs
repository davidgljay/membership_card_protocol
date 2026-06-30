#!/usr/bin/env node
/**
 * Federation smoke test (implementation-plan.md §Step 6.3).
 *
 * Stands up two wallet-service instances (node-server preset, separate
 * Postgres databases, configured as each other's peer), then verifies:
 *   1. Registering a card on instance A replicates the binding to B.
 *   2. A message addressed to that card, submitted to B, is correctly
 *      redirected (410) to A — confirming B's routing table is accurate.
 *   3. Submitting that message to A directly succeeds (202) and is
 *      delivered to a fake relay.
 *   4. A dual-signed card_migration announcement moves the card from A to
 *      B; both instances' routing tables update, and A now redirects to B.
 *
 * Usage: node scripts/federation-smoke-test.mjs
 * Requires: docker compose up -d (Postgres reachable on localhost:5433),
 * migrations already applied to the `wallet_service` database.
 *
 * This script is intentionally self-contained (spawns its own server
 * processes and a throwaway second database, cleans up after itself) so it
 * can be re-run on demand without leaving state behind — see Phase 4's
 * milestone summary, which flagged the lack of a repeatable harness as a
 * gap this script closes.
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import pg from 'pg';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { keccak_256 } from '@noble/hashes/sha3';

const ROOT = new URL('..', import.meta.url).pathname;
const PG_URL = 'postgres://wallet_service:wallet_service@localhost:5433';
const DB_B = 'wallet_service_federation_smoke_b';
const PORT_A = 3231;
const PORT_B = 3232;
const RELAY_PORT = 4001;

let fail = false;
function check(label, condition) {
  const ok = !!condition;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}`);
  if (!ok) fail = true;
  return ok;
}

function canonicalize(obj) {
  const ser = (v) => {
    if (v === null) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return JSON.stringify(v);
    if (typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(ser).join(',')}]`;
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${ser(v[k])}`).join(',')}}`;
  };
  return new TextEncoder().encode(ser(obj));
}

function genWalletServiceIdentity() {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const keys = ml_dsa44.keygen(seed);
  const id = '0x' + Buffer.from(keccak_256(keys.publicKey)).toString('hex');
  return { ...keys, id };
}

async function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: 'pipe', ...opts });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}\n${out}`))));
  });
}

function startServer(env, port, logFile) {
  const child = spawn('npx', ['nitro', 'dev', '--port', String(port)], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stream = fs.createWriteStream(logFile);
  child.stdout.pipe(stream);
  child.stderr.pipe(stream);
  return child;
}

async function waitForHealth(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  const adminPool = new pg.Pool({ connectionString: `${PG_URL}/wallet_service` });
  console.log(`Creating throwaway database ${DB_B}...`);
  await adminPool.query(`DROP DATABASE IF EXISTS ${DB_B}`);
  await adminPool.query(`CREATE DATABASE ${DB_B} OWNER wallet_service`);
  await adminPool.end();

  await run('npx', [
    'node-pg-migrate',
    'up',
    '--migrations-dir',
    'server/db/migrations',
    '--database-url-var',
    'DATABASE_URL',
  ], { env: { ...process.env, DATABASE_URL: `${PG_URL}/${DB_B}` } });

  const wsA = genWalletServiceIdentity();
  const wsB = genWalletServiceIdentity();

  const common = {
    SECRETS_BACKEND: 'webcrypto',
    WEBCRYPTO_MASTER_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    SESSION_TOKEN_SECRET: 'smoke-session-secret',
    WEBAUTHN_RP_ID: 'localhost',
    KV_BACKEND: 'postgres',
    RELAY_BASE_URL: `http://localhost:${RELAY_PORT}`,
  };

  const envA = {
    ...common,
    DATABASE_URL: `${PG_URL}/wallet_service`,
    WEBAUTHN_ORIGIN: `http://localhost:${PORT_A}`,
    WALLET_SERVICE_ID: wsA.id,
    WALLET_SERVICE_ENDPOINT: `http://localhost:${PORT_A}`,
    WALLET_SERVICE_PRIVATE_KEY: Buffer.from(wsA.secretKey).toString('base64url'),
    PEER_LIST: JSON.stringify([{ wallet_service_id: wsB.id, endpoint: `http://localhost:${PORT_B}`, pubkey_hash: 'unused' }]),
  };
  const envB = {
    ...common,
    DATABASE_URL: `${PG_URL}/${DB_B}`,
    WEBAUTHN_ORIGIN: `http://localhost:${PORT_B}`,
    WALLET_SERVICE_ID: wsB.id,
    WALLET_SERVICE_ENDPOINT: `http://localhost:${PORT_B}`,
    WALLET_SERVICE_PRIVATE_KEY: Buffer.from(wsB.secretKey).toString('base64url'),
    PEER_LIST: JSON.stringify([{ wallet_service_id: wsA.id, endpoint: `http://localhost:${PORT_A}`, pubkey_hash: 'unused' }]),
  };

  console.log('Starting instance A...');
  const procA = startServer(envA, PORT_A, '/tmp/federation-smoke-a.log');
  console.log('Starting instance B...');
  const procB = startServer(envB, PORT_B, '/tmp/federation-smoke-b.log');

  // fake relay so message delivery has somewhere to go
  const delivered = [];
  const relay = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/deliver/')) {
      delivered.push(req.url.split('/deliver/')[1]);
      res.writeHead(200);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => relay.listen(RELAY_PORT, resolve));

  try {
    check('instance A became healthy', await waitForHealth(PORT_A));
    check('instance B became healthy', await waitForHealth(PORT_B));

    const A = `http://localhost:${PORT_A}`;
    const B = `http://localhost:${PORT_B}`;

    // 1. Register a card on A.
    const ch = await (await fetch(`${A}/accounts/challenge`, { method: 'POST' })).json();
    const cardSeed = crypto.getRandomValues(new Uint8Array(32));
    const cardKeys = ml_dsa44.keygen(cardSeed);
    const sig = ml_dsa44.sign(Buffer.from(ch.challenge, 'base64url'), cardKeys.secretKey);
    const cardHash = '0x' + Buffer.from(keccak_256(cardKeys.publicKey)).toString('hex');

    const createRes = await fetch(`${A}/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challenge: ch.challenge,
        signature: Buffer.from(sig).toString('base64url'),
        card_hash: cardHash,
        master_pubkey: Buffer.from(cardKeys.publicKey).toString('base64url'),
        webauthn_credential_id: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url'),
        webauthn_public_key: Buffer.from('fake-cose-public-key').toString('base64url'),
        encrypted_keyring_blob: Buffer.from('federation-smoke-blob').toString('base64url'),
      }),
    });
    check('card registered on A', createRes.status === 200);

    await new Promise((r) => setTimeout(r, 500)); // let the binding broadcast land on B

    // 2. A message addressed to that card, submitted to B, should redirect to A.
    const subcardHash = '0xsubcard-' + crypto.randomUUID();
    const toB = await fetch(`${B}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: cardHash, subcard_hash: subcardHash, payload: Buffer.from('x').toString('base64url') }),
    });
    const toBBody = await toB.json();
    check('message to B redirects 410 to A', toB.status === 410 && toBBody.wallet_service_id === wsA.id);

    // 3. Submitting to A directly succeeds and is delivered to the relay.
    const uuid = crypto.randomUUID();
    const poolA = new pg.Pool({ connectionString: `${PG_URL}/wallet_service` });
    await poolA.query(
      `INSERT INTO uuid_pools (uuid, card_hash, subcard_hash, registered_at, expires_at) VALUES ($1,$2,$3,now(),now()+interval '30 days')`,
      [uuid, cardHash, subcardHash]
    );
    const toA = await fetch(`${A}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: cardHash, subcard_hash: subcardHash, payload: Buffer.from('cross-instance-content').toString('base64url') }),
    });
    check('message to A (the correct owner) accepted (202)', toA.status === 202);
    check('message delivered to relay', delivered.includes(uuid));

    // 4. Card migration: dual-signed announcement moves the card from A to B.
    const migrationPayload = {
      type: 'card_migration',
      card_hash: cardHash,
      wallet_service_id: wsB.id,
      endpoint: B,
      timestamp: new Date().toISOString(),
      nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
    };
    const migMessage = canonicalize(migrationPayload);
    const wsSig = ml_dsa44.sign(migMessage, wsB.secretKey);
    const cardholderSig = ml_dsa44.sign(migMessage, cardKeys.secretKey);
    const migrationEnvelope = {
      payload: migrationPayload,
      signatures: [
        { public_key: Buffer.from(wsB.publicKey).toString('base64url'), role: 'wallet_service', signature: Buffer.from(wsSig).toString('base64url') },
        { public_key: Buffer.from(cardKeys.publicKey).toString('base64url'), role: 'cardholder', signature: Buffer.from(cardholderSig).toString('base64url') },
      ],
    };

    // Announce to both instances (in practice the originating instance
    // broadcasts; here we simulate that fan-out directly for the test).
    const announceA = await fetch(`${A}/bindings/announce`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(migrationEnvelope) });
    const announceB = await fetch(`${B}/bindings/announce`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(migrationEnvelope) });
    check('migration announcement applied on A', (await announceA.json()).applied === true);
    check('migration announcement applied on B', (await announceB.json()).applied === true);

    const toAAfterMigration = await fetch(`${A}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: cardHash, subcard_hash: subcardHash, payload: Buffer.from('x').toString('base64url') }),
    });
    const toAAfterMigrationBody = await toAAfterMigration.json();
    check(
      'A now redirects to B after migration (410, correct wallet_service_id)',
      toAAfterMigration.status === 410 && toAAfterMigrationBody.wallet_service_id === wsB.id
    );

    await poolA.end();
  } finally {
    procA.kill();
    procB.kill();
    relay.close();
    const cleanupPool = new pg.Pool({ connectionString: `${PG_URL}/wallet_service` });
    await cleanupPool.query(`DROP DATABASE IF EXISTS ${DB_B}`).catch(() => {});
    await cleanupPool.end();
  }

  console.log(fail ? '\nFEDERATION SMOKE TEST: FAILED' : '\nFEDERATION SMOKE TEST: ALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
