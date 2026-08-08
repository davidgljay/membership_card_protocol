/**
 * `specs/process_specs/matrix_room_membership.md` +
 * `specs/process_specs/matrix_join_attestation_and_revocation.md`. Ported
 * from
 * integration_tests/suites/matrix-relay/matrix_room_membership.spec.ts
 * unchanged in test logic -- this suite was already migrated off
 * client-sdk onto app-sdk/wallet-sdk's new `matrix/` modules (see
 * plans/deployment/client-sdk-deprecation-plan.md), so only import sources
 * changed: published `app-sdk`/`wallet-sdk`, and `../../support/matrixAdmin.ts`.
 *
 * Requires a dev Matrix/Synapse deployment -- see
 * dev-tests/support/matrixAdmin.ts's header comment and
 * plans/deployment/phase-3-summary.md's outstanding items.
 *
 * Scoping: unlike integration_tests' copy, this deployment's Synapse *does*
 * have wallet-service's Application Service wired in with an exclusive
 * `card_*` namespace, so test users are registered via the AS's own
 * as_token rather than shared-secret admin registration (see matrixAdmin.ts's
 * header comment) -- still bypassing wallet-service's HTTP API, just not
 * Synapse's AS-ownership check. Synapse's policy module points
 * at real Arbitrum Sepolia with no IPFS-pinning capability here, so any
 * scenario requiring a *satisfying* card is out of scope. Every deny path
 * that doesn't depend on a real chain resolving is fully in scope and
 * tested for real, including a validly-signed, correctly-bound attestation
 * for a card that doesn't exist on-chain.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mlDsa44GenerateKeypair, keccak256, deriveMatrixUserId } from '@membership-card-protocol/app-sdk';
import {
  buildJoinAttestation,
  JOIN_ATTESTATION_EVENT_CONTENT_KEY,
} from '@membership-card-protocol/wallet-sdk';
import {
  SYNAPSE_BASE_URL,
  MATRIX_SERVER_NAME,
  MATRIX_ENFORCEMENT_USER_ID,
  registerMatrixUserViaAppService,
  createCardGatedRoom,
  fetchRoomState,
  type RegisteredMatrixUser,
} from '../../support/matrixAdmin.js';

function localpartFor(keypair: { publicKey: Uint8Array }): { localpart: string; matrixUserId: string } {
  const cardHash = '0x' + keccak256(keypair.publicKey);
  const matrixUserId = deriveMatrixUserId(cardHash, MATRIX_SERVER_NAME);
  const localpart = matrixUserId.slice(1, matrixUserId.indexOf(':'));
  return { localpart, matrixUserId };
}

describe('matrix_room_membership.md + matrix_join_attestation_and_revocation.md (live dev deployment)', () => {
  let creator: RegisteredMatrixUser;
  let creatorMatrixUserId: string;
  let policyId: string;
  let roomId: string;

  beforeAll(async () => {
    const creatorKeypair = mlDsa44GenerateKeypair();
    const { localpart, matrixUserId } = localpartFor(creatorKeypair);
    creatorMatrixUserId = matrixUserId;
    creator = await registerMatrixUserViaAppService(localpart);
    expect(creator.userId).toBe(creatorMatrixUserId);

    policyId = 'bafyreig' + Buffer.from(keccak256(new TextEncoder().encode('matrix-room-membership-suite')).slice(0, 32), 'hex').toString('hex') + 'fixturepolicy';

    const room = await createCardGatedRoom({
      creatorMatrixUserId,
      creatorAccessToken: creator.accessToken,
      policyId,
      name: 'matrix_room_membership suite fixture room',
      topic: 'dev-tests suite fixture',
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
      const joinerKeypair = mlDsa44GenerateKeypair();
      const { localpart } = localpartFor(joinerKeypair);
      const joiner = await registerMatrixUserViaAppService(localpart);
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
      const joiner = await registerMatrixUserViaAppService(localpart);

      const res = await fetch(`${SYNAPSE_BASE_URL}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${joiner.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          [JOIN_ATTESTATION_EVENT_CONTENT_KEY]: {
            payload: {
              type: 'room_join_attestation',
              card_hash: 'bm90LWEtcmVhbC1jYXJkLWhhc2g',
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

    it('denies (403) a join with a validly-signed, correctly-bound attestation for a card that does not exist on-chain', async () => {
      const joinerKeypair = mlDsa44GenerateKeypair();
      const { localpart, matrixUserId } = localpartFor(joinerKeypair);
      const joiner = await registerMatrixUserViaAppService(localpart);
      expect(joiner.userId).toBe(matrixUserId);

      const attestation = buildJoinAttestation(joinerKeypair.secretKey, roomId, MATRIX_SERVER_NAME);
      expect(attestation.payload.matrix_user_id).toBe(matrixUserId);

      const res = await fetch(`${SYNAPSE_BASE_URL}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${joiner.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ [JOIN_ATTESTATION_EVENT_CONTENT_KEY]: attestation }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { errcode?: string };
      expect(body.errcode).toBe('M_FORBIDDEN');
    }, 15_000);

    it('none of the denied joiners appear in the room member list', async () => {
      const res = await fetch(
        `${SYNAPSE_BASE_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
        { headers: { Authorization: `Bearer ${creator.accessToken}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { joined?: Record<string, unknown> };
      expect(Object.keys(body.joined ?? {})).toEqual([creatorMatrixUserId]);
    });
  });
});
