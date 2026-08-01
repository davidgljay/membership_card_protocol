/**
 * `specs/process_specs/room_discovery.md`. Ported from
 * integration_tests/suites/matrix-relay/room_discovery.spec.ts unchanged in
 * test logic -- this suite was already migrated off client-sdk onto
 * wallet-sdk's new `matrix/` module (see
 * plans/deployment/client-sdk-deprecation-plan.md), so only the import
 * source and `WALLET_SERVICE_BASE_URL` sourcing changed (published
 * `app-sdk`/`wallet-sdk`/`verifier`, `../../support/liveCard.js` instead of
 * `process.env.SUITE_*`). No Synapse dependency at all -- exercises
 * wallet-service's own `/matrix/room-index`/`/matrix/discover-rooms`
 * endpoints and wallet-sdk's pure `buildRoomDiscoveryEnvelope`.
 *
 * Scoping, unchanged from the original suite (see its full header comment
 * for the complete rationale): wallet-service's Application Service token
 * gap means `POST /matrix/rooms` never succeeds anywhere this stack runs,
 * so the room index stays permanently empty and every session-token-gated
 * scenario stays `it.todo`. No real on-chain card / IPFS-pinning capability
 * means the full client-side discovery algorithm can't be exercised
 * end-to-end either.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  mlDsa44GenerateKeypair,
  mlDsa44GetPublicKey,
  keccak256,
  base64UrlToBytes,
} from '@membership-card-protocol/app-sdk';
import { buildRoomDiscoveryEnvelope } from '@membership-card-protocol/wallet-sdk';
import { canonicalize as verifierCanonicalize, mlDsa44Verify as verifierMlDsa44Verify } from '@membership-card-protocol/verifier';
import { WALLET_SERVICE_BASE_URL } from '../../support/liveCard.js';

describe('room_discovery.md (live dev deployment)', () => {
  beforeAll(async () => {
    const healthRes = await fetch(`${WALLET_SERVICE_BASE_URL}/health`, { method: 'GET' });
    expect(healthRes.ok).toBe(true);
  }, 10_000);

  describe('§1 The Room Index (GET /matrix/room-index)', () => {
    it('is publicly accessible without authentication', async () => {
      const res = await fetch(`${WALLET_SERVICE_BASE_URL}/matrix/room-index`, {
        method: 'GET',
      });
      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
    });

    it('returns the correct response shape: { rooms: [...], updated_at: ... }', async () => {
      const res = await fetch(`${WALLET_SERVICE_BASE_URL}/matrix/room-index`, {
        method: 'GET',
      });
      expect(res.ok).toBe(true);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toHaveProperty('rooms');
      expect(body).toHaveProperty('updated_at');
      expect(Array.isArray(body.rooms)).toBe(true);
      expect(typeof body.updated_at).toBe('string');
    });

    it('each room entry has room_id, policy_id, and created_at', async () => {
      const res = await fetch(`${WALLET_SERVICE_BASE_URL}/matrix/room-index`, {
        method: 'GET',
      });
      const body = (await res.json()) as { rooms: Array<Record<string, unknown>> };
      for (const entry of body.rooms) {
        expect(entry).toHaveProperty('room_id');
        expect(entry).toHaveProperty('policy_id');
        expect(entry).toHaveProperty('created_at');
        expect(typeof entry.room_id).toBe('string');
        expect(typeof entry.policy_id).toBe('string');
        expect(typeof entry.created_at).toBe('string');
      }
    });

    it('sets Cache-Control header for public CDN caching (max-age=30)', async () => {
      const res = await fetch(`${WALLET_SERVICE_BASE_URL}/matrix/room-index`, {
        method: 'GET',
      });
      const cacheControl = res.headers.get('Cache-Control');
      expect(cacheControl).toBeTruthy();
      expect(cacheControl).toContain('public');
      expect(cacheControl).toContain('max-age=30');
    });

    it('returns an empty rooms array initially (before any rooms are created)', async () => {
      const res = await fetch(`${WALLET_SERVICE_BASE_URL}/matrix/room-index`, {
        method: 'GET',
      });
      const body = (await res.json()) as { rooms: unknown[] };
      expect(body.rooms).toEqual([]);
    });

    it('updated_at is always present, even for an empty room index', async () => {
      const res = await fetch(`${WALLET_SERVICE_BASE_URL}/matrix/room-index`, {
        method: 'GET',
      });
      const body = (await res.json()) as { updated_at: unknown };
      expect(body.updated_at).toBeTruthy();
      const date = new Date(body.updated_at as string);
      expect(isNaN(date.getTime())).toBe(false);
    });

    it.todo(
      '[Blocker: AS token missing] POST /matrix/rooms would populate room-index entries, ' +
        'but wallet-service cannot provision shadow accounts without the missing AS token file.'
    );
  });

  describe('§2 Client-Side Discovery (default algorithm)', () => {
    it('wallet-sdk exports buildRoomDiscoveryEnvelope and discoverRooms as expected', () => {
      const keypair = mlDsa44GenerateKeypair();
      const envelope = buildRoomDiscoveryEnvelope(keypair.secretKey);
      expect(envelope).toHaveProperty('payload');
      expect(envelope).toHaveProperty('signatures');
      expect(Array.isArray(envelope.signatures)).toBe(true);
      expect(envelope.signatures.length).toBeGreaterThan(0);
    });

    it('buildRoomDiscoveryEnvelope signs a room-discovery statement with the card private key, and the signature verifies', () => {
      const keypair = mlDsa44GenerateKeypair();
      const envelope = buildRoomDiscoveryEnvelope(keypair.secretKey);
      const sig = envelope.signatures[0];
      expect(sig).toBeDefined();
      if (!sig) return;

      const publicKeyBytes = mlDsa44GetPublicKey(keypair.secretKey);
      expect(base64UrlToBytes(sig.public_key)).toEqual(publicKeyBytes);
      expect(
        verifierMlDsa44Verify(base64UrlToBytes(sig.public_key), verifierCanonicalize(envelope.payload), base64UrlToBytes(sig.signature))
      ).toBe(true);
    });

    it('envelope payload contains message, protocol_version, and timestamp', () => {
      const keypair = mlDsa44GenerateKeypair();
      const envelope = buildRoomDiscoveryEnvelope(keypair.secretKey);
      const payload = envelope.payload as Record<string, unknown>;
      expect(payload.message).toBe('room-discovery-chain-walk');
      expect(payload.protocol_version).toBeTruthy();
      expect(payload.timestamp).toBeTruthy();
    });

    it.todo(
      '[Blocker: No real chain / IPFS] The full client-side algorithm cannot succeed ' +
        'end-to-end in this environment -- no real card can be minted with a satisfiable ' +
        'pinned predicate document without the dev governance prerequisites this whole ' +
        'suite set depends on.'
    );
  });

  describe('§3 Server-Hosted Discovery (POST /matrix/discover-rooms)', () => {
    let testKeypair: ReturnType<typeof mlDsa44GenerateKeypair>;

    beforeAll(() => {
      testKeypair = mlDsa44GenerateKeypair();
    });

    it('requires a session token (returns 401 without one)', async () => {
      const envelope = buildRoomDiscoveryEnvelope(testKeypair.secretKey);
      const res = await fetch(`${WALLET_SERVICE_BASE_URL}/matrix/discover-rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ envelope }),
      });
      expect(res.status).toBe(401);
    });

    it('requires an envelope field in the request body', async () => {
      const res = await fetch(`${WALLET_SERVICE_BASE_URL}/matrix/discover-rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect([400, 401]).toContain(res.status);
    });

    it.todo(
      '[Requires session token] returns { room_ids: string[] } shape on a real authenticated call'
    );

    it.todo(
      '[Requires session token] full accounts flow (mint card, sign challenge) needed to test ' +
        'authenticated discovery -- out of scope for this suite, see core/ suites for the accounts flow.'
    );

    it.todo(
      '[Requires valid signer_card binding] verifying the envelope\'s recovered signer_card ' +
        'matches the authenticated session\'s card_hash needs a real session token.'
    );

    it.todo(
      '[Requires valid chain-walk] discoverEligibleRooms needs a real chain/IPFS-satisfiable card.'
    );

    it.todo(
      '[Requires session token] rate-limiting (429 after 30 calls/60s/card) needs a valid session token.'
    );
  });

  describe('Envelope validation edge cases', () => {
    it('a malformed envelope (invalid JSON) returns a parse error', async () => {
      const res = await fetch(`${WALLET_SERVICE_BASE_URL}/matrix/discover-rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json at all',
      });
      expect([400, 401]).toContain(res.status);
    });

    it.todo(
      '[Requires session token] an envelope with an empty signatures array returns 403 InvalidDiscoveryEnvelopeError'
    );
  });

  describe('Room index integration', () => {
    it('room index entries are ISO-8601 datetime strings', async () => {
      const res = await fetch(`${WALLET_SERVICE_BASE_URL}/matrix/room-index`, {
        method: 'GET',
      });
      const body = (await res.json()) as { rooms?: Array<{ created_at?: string }> };
      if (!body.rooms) return;
      for (const entry of body.rooms) {
        if (!entry.created_at) continue;
        const date = new Date(entry.created_at);
        expect(isNaN(date.getTime())).toBe(false);
        expect(entry.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      }
    });

    it('the room index is ordered oldest-first (by created_at ASC)', async () => {
      const res = await fetch(`${WALLET_SERVICE_BASE_URL}/matrix/room-index`, {
        method: 'GET',
      });
      const body = (await res.json()) as { rooms?: Array<{ created_at?: string }> };
      if (!body.rooms || body.rooms.length < 2) return;
      for (let i = 1; i < body.rooms.length; i++) {
        const prev = body.rooms[i - 1]?.created_at;
        const curr = body.rooms[i]?.created_at;
        if (!prev || !curr) continue;
        const prevDate = new Date(prev);
        const currDate = new Date(curr);
        expect(prevDate.getTime()).toBeLessThanOrEqual(currDate.getTime());
      }
    });

    it.todo(
      '[Blocker: AS token missing] A room created via POST /matrix/rooms would appear in ' +
        'GET /matrix/room-index on the very next read -- cannot be tested until the AS gap is wired up.'
    );
  });

  describe('Response caching behavior', () => {
    it('Cache-Control allows public caching (max-age not too high for freshness)', async () => {
      const res = await fetch(`${WALLET_SERVICE_BASE_URL}/matrix/room-index`, {
        method: 'GET',
      });
      const cacheControl = res.headers.get('Cache-Control');
      expect(cacheControl).toContain('public');
      expect(cacheControl).toContain('max-age=30');
    });

    it('updated_at timestamp is always current (not stale from a previous response)', async () => {
      const res1 = await fetch(`${WALLET_SERVICE_BASE_URL}/matrix/room-index`, {
        method: 'GET',
      });
      const body1 = (await res1.json()) as { updated_at: string };
      const timestamp1 = new Date(body1.updated_at);

      await new Promise((resolve) => setTimeout(resolve, 100));

      const res2 = await fetch(`${WALLET_SERVICE_BASE_URL}/matrix/room-index`, {
        method: 'GET',
      });
      const body2 = (await res2.json()) as { updated_at: string };
      const timestamp2 = new Date(body2.updated_at);

      expect(timestamp2.getTime()).toBeGreaterThanOrEqual(timestamp1.getTime());
    });
  });
});
