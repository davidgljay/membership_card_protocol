/**
 * `specs/process_specs/matrix_join_attestation_and_revocation.md`. Ported
 * from
 * integration_tests/suites/matrix-relay/matrix_join_attestation_and_revocation.spec.ts
 * unchanged in test logic -- this suite was already migrated off client-sdk
 * onto app-sdk/wallet-sdk's new `matrix/` modules (see
 * plans/deployment/client-sdk-deprecation-plan.md), so only import sources
 * changed: published `app-sdk`/`wallet-sdk`, and
 * `../../support/matrixAdmin.ts` (dev-tests' own copy, config sourced from
 * `DEV_SYNAPSE_URL`/etc. -- see that file and dev-tests/.env.example).
 *
 * Requires a dev Matrix/Synapse deployment -- see
 * dev-tests/support/matrixAdmin.ts's header comment and
 * plans/deployment/phase-3-summary.md's outstanding items.
 *
 * Complements `matrix_room_membership.spec.ts` by focusing on §2a's
 * post-time identity resolution via the membership registry and the
 * explicit "Creator auto-join" / "Server-administrator-forced joins"
 * carve-outs. §3 (event-driven revocation watcher) is entirely out of
 * scope -- confirmed via matrix_policy_module/module.py's own docstring
 * that PolicyModule.__init__ never constructs a Watcher in this build.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mlDsa44GenerateKeypair, keccak256, deriveMatrixUserId } from '@membership-card-protocol/app-sdk';
import { buildJoinAttestation } from '@membership-card-protocol/wallet-sdk';
import {
  SYNAPSE_BASE_URL,
  MATRIX_SERVER_NAME,
  registerMatrixUserViaSharedSecret,
  createCardGatedRoom,
  submitRoomCreatorAttestation,
  type RegisteredMatrixUser,
} from '../../support/matrixAdmin.js';

function localpartFor(keypair: { publicKey: Uint8Array }): { localpart: string; matrixUserId: string } {
  const cardHash = '0x' + keccak256(keypair.publicKey);
  const matrixUserId = deriveMatrixUserId(cardHash, MATRIX_SERVER_NAME);
  const localpart = matrixUserId.slice(1, matrixUserId.indexOf(':'));
  return { localpart, matrixUserId };
}

async function sendTextMessage(roomId: string, accessToken: string): Promise<Response> {
  const txnId = `suite-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return fetch(
    `${SYNAPSE_BASE_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'm.text', body: 'dev-tests probe message' }),
    }
  );
}

describe('matrix_join_attestation_and_revocation.md (live dev deployment)', () => {
  let creator: RegisteredMatrixUser;
  let creatorMatrixUserId: string;
  let roomId: string;

  beforeAll(async () => {
    const creatorKeypair = mlDsa44GenerateKeypair();
    const { localpart, matrixUserId } = localpartFor(creatorKeypair);
    creatorMatrixUserId = matrixUserId;
    creator = await registerMatrixUserViaSharedSecret(localpart);

    const room = await createCardGatedRoom({
      creatorMatrixUserId,
      creatorAccessToken: creator.accessToken,
      policyId: 'bafyreig' + Buffer.from(keccak256(new TextEncoder().encode('join-attestation-suite')).slice(0, 32), 'hex').toString('hex') + 'fixturepolicy',
      name: 'matrix_join_attestation_and_revocation suite fixture room',
    });
    roomId = room.roomId;

    const creatorAttestation = buildJoinAttestation(creatorKeypair.secretKey, roomId, MATRIX_SERVER_NAME);
    const attestationRes = await submitRoomCreatorAttestation(roomId, creator.accessToken, creatorAttestation);
    expect(attestationRes.ok).toBe(true);
  }, 30_000);

  describe('§2a Post-Time Identity Resolution', () => {
    it.todo(
      'the room creator, having submitted their own creator attestation, can post in their own room — needs a real on-chain card + satisfiable pinned policy, same gap as the rest of this file'
    );

    it('a post from an account with no membership-registry entry at all is denied the same way (baseline, not creator-specific)', async () => {
      const strangerKeypair = mlDsa44GenerateKeypair();
      const { localpart } = localpartFor(strangerKeypair);
      const stranger = await registerMatrixUserViaSharedSecret(localpart);
      const res = await sendTextMessage(roomId, stranger.accessToken);
      expect(res.status).toBe(403);
    }, 15_000);

    it('a creator who never submits the creator attestation is still denied — the fix is opt-in, not a bypass', async () => {
      const otherCreatorKeypair = mlDsa44GenerateKeypair();
      const { localpart, matrixUserId } = localpartFor(otherCreatorKeypair);
      const otherCreator = await registerMatrixUserViaSharedSecret(localpart);

      const otherRoom = await createCardGatedRoom({
        creatorMatrixUserId: matrixUserId,
        creatorAccessToken: otherCreator.accessToken,
        policyId: 'bafyreig' + Buffer.from(keccak256(new TextEncoder().encode('no-attestation-creator')).slice(0, 32), 'hex').toString('hex') + 'fixturepolicy',
        name: 'no-attestation creator fixture room',
      });
      const res = await sendTextMessage(otherRoom.roomId, otherCreator.accessToken);
      expect(res.status).toBe(403);
    }, 30_000);
  });

  describe('Server-administrator-forced joins (documented, not this environment\'s to exercise)', () => {
    it.todo('an admin-forced join produces no membership-registry entry and denies the account\'s next post — documented as intentional, not exercised in this environment');
  });
});
