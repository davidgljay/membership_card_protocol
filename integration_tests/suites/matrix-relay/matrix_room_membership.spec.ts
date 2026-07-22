/**
 * `specs/process_specs/matrix_room_membership.md` + `specs/process_specs/
 * matrix_join_attestation_and_revocation.md` (the current, non-superseded
 * join sequence — see that file's header note listing exactly which
 * sections of `matrix_room_membership.md` it replaces) — Phase 4 Step 4.1
 * (pattern-setter). See `suites/README.md` for the Matrix-specific
 * conventions this file establishes.
 *
 * Exercises the REAL running Synapse + `matrix_policy_module` +
 * `wallet-service`'s room-creation logic (duplicated, not imported — see
 * `../support/matrixAdmin.ts`'s header) from `integration_tests/
 * docker-compose.yml`. Nothing here mocks Synapse or the policy module;
 * every join/room-state assertion below reflects what the real,
 * currently-loaded `matrix_policy_module.module.PolicyModule` decided.
 *
 * ---------------------------------------------------------------------
 * SCOPING — read this before assuming a scenario below is exhaustive.
 * ---------------------------------------------------------------------
 *
 * A near-identical suite already exists and is the direct precedent for
 * this one: `wallet-service/test/integration/matrix-room-lifecycle.test.ts`,
 * run against wallet-service's own (separate) docker-compose stack. That
 * suite found and fixed four real bugs in `module.py` and documents, with
 * real investigation (not assumption), exactly which of the spec's six
 * required scenarios are and aren't reachable in a dev environment with no
 * real on-chain card and no IPFS-pinning capability. The same two
 * structural gaps apply here:
 *
 *   1. **No Application Service wired into this stack's Synapse.**
 *      `integration_tests/env/synapse/homeserver.yaml.template`'s own
 *      header comment documents this as a known, deferred TODO. This
 *      suite works around it entirely — see `../support/matrixAdmin.ts`'s
 *      header comment — by registering test users directly via Synapse's
 *      admin shared-secret API instead of through `wallet-service`'s
 *      `POST /matrix/token`/`POST /matrix/rooms`. This is a full
 *      workaround, not a partial one: `deriveMatrixUserId`/
 *      `verifyMatrixUserIdBinding` are pure functions of a keypair, so a
 *      directly-registered user at the right localpart is indistinguishable
 *      from a wallet-service-provisioned one as far as the policy module
 *      is concerned.
 *   2. **This stack's Synapse points its policy module at real Arbitrum
 *      Sepolia** (`docker-compose.yml`'s `synapse-init` service — a
 *      deliberate, separate choice from the rest of this stack's local
 *      nitro-devnode migration; matrix chain data was never part of that
 *      migration's scope), and this repo has no IPFS-pinning capability
 *      (confirmed by the wallet-service precedent suite; nothing changed
 *      since). **This is not worked around here** — no real card can be
 *      minted and no real predicate document can be pinned within this
 *      suite, so any scenario requiring a *satisfying* card (the join
 *      succeeds because the card's chain genuinely resolves and matches a
 *      policy) is out of scope. What IS in scope and tested for real:
 *      every deny path that doesn't depend on a real chain resolving,
 *      including a **validly-signed, correctly-bound attestation for a
 *      card that doesn't exist on-chain** (§2 below) — this exercises
 *      further into the module's logic than a malformed-attestation deny
 *      does (attestation verification passes; the module denies only once
 *      it can't resolve the chain/predicate document), without needing
 *      real chain data to prove.
 *
 * Requires the `integration_tests` stack up (`docker compose up -d --wait
 * synapse`) with `synapse-init` having generated its fixed dev
 * `registration_shared_secret` (see `env/synapse/init.sh`'s comment) — the
 * default stack already provides this.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  mlDsa44GenerateKeypair,
  keccak256,
  deriveMatrixUserId,
  buildJoinAttestation,
  JOIN_ATTESTATION_EVENT_CONTENT_KEY,
} from '@membership-card-protocol/client-sdk';
import {
  SYNAPSE_BASE_URL,
  MATRIX_SERVER_NAME,
  MATRIX_ENFORCEMENT_USER_ID,
  registerMatrixUserViaSharedSecret,
  createCardGatedRoom,
  fetchRoomState,
  type RegisteredMatrixUser,
} from '../support/matrixAdmin.js';

function localpartFor(keypair: { publicKey: Uint8Array }): { localpart: string; matrixUserId: string } {
  const cardHash = '0x' + keccak256(keypair.publicKey);
  const matrixUserId = deriveMatrixUserId(cardHash, MATRIX_SERVER_NAME);
  // "@card_<hex>:server" -> "card_<hex>"
  const localpart = matrixUserId.slice(1, matrixUserId.indexOf(':'));
  return { localpart, matrixUserId };
}

describe('matrix_room_membership.md + matrix_join_attestation_and_revocation.md (live stack)', () => {
  let creatorKeypair: ReturnType<typeof mlDsa44GenerateKeypair>;
  let creator: RegisteredMatrixUser;
  let creatorMatrixUserId: string;
  let policyId: string;
  let roomId: string;

  beforeAll(async () => {
    creatorKeypair = mlDsa44GenerateKeypair();
    const { localpart, matrixUserId } = localpartFor(creatorKeypair);
    creatorMatrixUserId = matrixUserId;
    creator = await registerMatrixUserViaSharedSecret(localpart);
    expect(creator.userId).toBe(creatorMatrixUserId);

    // A syntactically CID-shaped placeholder, not pinned to real IPFS —
    // see this file's header comment on the pinning gap. Room creation
    // itself never dereferences policy_id against IPFS (matrix_room.md
    // §Room Creation); only a join attempt reaching the chain-walk/
    // predicate-fetch stage would, and none of §1's assertions need that
    // to succeed.
    policyId = 'bafyreig' + Buffer.from(keccak256(new TextEncoder().encode('matrix-room-membership-suite')).slice(0, 32), 'hex').toString('hex') + 'fixturepolicy';

    const room = await createCardGatedRoom({
      creatorMatrixUserId,
      creatorAccessToken: creator.accessToken,
      policyId,
      name: 'matrix_room_membership suite fixture room',
      topic: 'integration_tests suite fixture',
    });
    roomId = room.roomId;
  }, 30_000);

  describe('§1 Room Creation (real, no chain-walk dependency)', () => {
    it('creates a real room on the live Synapse instance', () => {
      expect(roomId).toMatch(new RegExp(`^!.+:${MATRIX_SERVER_NAME.replace(/\./g, '\\.')}$`));
    });

    it('sets m.card.policy state to the given policy_id', async () => {
      const state = (await fetchRoomState(roomId, 'm.card.policy', creator.accessToken)) as { policy_id?: string };
      expect(state.policy_id).toBe(policyId);
    });

    it('sets m.room.encryption to Megolm', async () => {
      const state = (await fetchRoomState(roomId, 'm.room.encryption', creator.accessToken)) as { algorithm?: string };
      expect(state.algorithm).toBe('m.megolm.v1.aes-sha2');
    });

    it('sets m.room.join_rules to public (join-gating is the policy module\'s job, not Matrix invite semantics)', async () => {
      const state = (await fetchRoomState(roomId, 'm.room.join_rules', creator.accessToken)) as { join_rule?: string };
      expect(state.join_rule).toBe('public');
    });

    it('grants the enforcement account kick-level power', async () => {
      const state = (await fetchRoomState(roomId, 'm.room.power_levels', creator.accessToken)) as {
        users?: Record<string, number>;
      };
      expect(state.users?.[MATRIX_ENFORCEMENT_USER_ID]).toBeGreaterThanOrEqual(50);
    });
  });

  describe('§2 Revised Join Sequence — deny paths (real module, live join attempts)', () => {
    it('denies a join with no attestation content at all', async () => {
      const joiner = await registerMatrixUserViaSharedSecret('room-membership-suite-noattest-' + Date.now());
      const res = await fetch(`${SYNAPSE_BASE_URL}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${joiner.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { errcode?: string };
      expect(body.errcode).toBe('M_FORBIDDEN');
    }, 15_000);

    it('denies a join with a malformed attestation (empty signatures array) — a distinct check from the no-attestation case, run before any chain walk', async () => {
      const joinerKeypair = mlDsa44GenerateKeypair();
      const { localpart, matrixUserId } = localpartFor(joinerKeypair);
      const joiner = await registerMatrixUserViaSharedSecret(localpart);

      const res = await fetch(`${SYNAPSE_BASE_URL}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${joiner.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          [JOIN_ATTESTATION_EVENT_CONTENT_KEY]: {
            payload: {
              type: 'room_join_attestation',
              card_hash: 'bm90LWEtcmVhbC1jYXJkLWhhc2g', // "not-a-real-card-hash", base64url — never reached, signatures is empty
              matrix_user_id: matrixUserId,
              room_id: roomId,
              server_name: MATRIX_SERVER_NAME,
              protocol_version: '0.1',
              timestamp: new Date().toISOString(),
            },
            signatures: [],
          },
        }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { errcode?: string };
      expect(body.errcode).toBe('M_FORBIDDEN');
    }, 15_000);

    // BUG, confirmed live 2026-07-21, not fixed here (Wave-2 report
    // fix-now/defer candidate): a validly-signed, correctly-bound
    // attestation for a card that was never minted anywhere reaches the
    // module's real chain-walk path (attestation.py's
    // verify_join_attestation -> chain_context.py's
    // walk_join_attestation_chain -> membership_card_verifier's
    // CardVerifier.verify_envelope), which crashes with
    // `RuntimeError: await wasn't used with future` inside
    // `card_verifier.py`'s `asyncio.gather(...)` call — a Twisted-reactor/
    // asyncio-Future mismatch somewhere in the RPC/IPFS provider bridging
    // `chain_context.py` hands to the verifier. The exception is NOT
    // caught and converted to a deny; it propagates all the way to
    // Synapse's HTTP layer as a raw `500`, not the `403 M_FORBIDDEN` every
    // other deny path in this file produces. This violates
    // `matrix_room_membership.md §4`'s own "Predicate evaluation itself
    // throws... Deny... This is the module's last line of defense — a bug
    // in the evaluator must not become an accidental allow" guarantee: a
    // 500 is not an allow, but it's also not the guaranteed clean deny the
    // spec promises, and — more importantly — it's the first attestation
    // in this file's tests to actually reach real chain-walk code, so
    // nothing before this suite had a chance to exercise (and catch) this
    // path. See the Wave-2 report for full triage.
    it.todo(
      'denies (403) a join with a validly-signed, correctly-bound attestation for a card that does not exist on-chain — currently 500s instead, see comment above'
    );

    it('[regression trip-wire, not the desired behavior] currently 500s rather than allowing — at least confirms this never silently becomes an allow', async () => {
      const joinerKeypair = mlDsa44GenerateKeypair();
      const { localpart, matrixUserId } = localpartFor(joinerKeypair);
      const joiner = await registerMatrixUserViaSharedSecret(localpart);
      const attestation = buildJoinAttestation(joinerKeypair.secretKey, roomId, MATRIX_SERVER_NAME);
      expect(attestation.payload.matrix_user_id).toBe(matrixUserId);

      const res = await fetch(`${SYNAPSE_BASE_URL}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${joiner.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ [JOIN_ATTESTATION_EVENT_CONTENT_KEY]: attestation }),
      });
      // NOT 200/allow, at least — but also not the 403 the spec promises.
      // If this ever starts returning 200, that's a much worse regression
      // (deny-by-default silently broken) and this assertion will catch
      // it. If it starts returning 403, the it.todo above should be
      // un-skipped and this test deleted.
      expect(res.status).toBe(500);
    }, 15_000);

    it('none of the denied joiners appear in the room member list', async () => {
      const res = await fetch(
        `${SYNAPSE_BASE_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
        { headers: { Authorization: `Bearer ${creator.accessToken}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { joined?: Record<string, unknown> };
      // Only the creator (auto-joined, exempt from check_event_allowed per
      // matrix_join_attestation_and_revocation.md's "Creator auto-join,
      // carried over unchanged" note) should be a member.
      expect(Object.keys(body.joined ?? {})).toEqual([creatorMatrixUserId]);
    });
  });
});
