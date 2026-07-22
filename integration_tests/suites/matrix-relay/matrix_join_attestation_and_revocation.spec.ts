/**
 * `specs/process_specs/matrix_join_attestation_and_revocation.md` — Phase 4
 * Step 4.2. Complements `matrix_room_membership.spec.ts` (Step 4.1, which
 * covers §1/§2's attestation shape and join-deny paths) by focusing on the
 * parts that spec is *specifically* about and the room-membership suite
 * doesn't: §2a's post-time identity resolution via the membership registry,
 * and the explicit "Creator auto-join" / "Server-administrator-forced
 * joins" carve-outs. Read `matrix_room_membership.spec.ts`'s header comment
 * first — the same scoping (no AS wiring in this stack, no real chain data
 * reachable) and the same `../support/matrixAdmin.ts` bypass apply here.
 *
 * §3 (event-driven revocation watcher) is entirely out of scope: confirmed
 * via `matrix_policy_module/module.py`'s own docstring/TODO that
 * `PolicyModule.__init__` never constructs or starts a `Watcher` in this
 * build — there is nothing running to observe force-part behavior against.
 *
 * ---------------------------------------------------------------------
 * BUG FOUND WRITING THIS SUITE — confirmed live, not fixed here
 * ---------------------------------------------------------------------
 *
 * The spec's own "Creator auto-join, carried over unchanged" paragraph
 * (§2) states plainly: "since their own join never reaches
 * `check_event_for_spam`, whatever code path handles their auto-join has
 * to register the entry directly ... or their first post would have no
 * registry entry to resolve against." Confirmed empirically below (§2a
 * scenario): **it doesn't.** `wallet-service/src/matrix/room-creation.ts`'s
 * `createMatrixRoomViaSynapse` only calls Synapse's `/createRoom` and
 * returns — nothing calls into the membership registry. The room
 * creator's own very first post to their own freshly-created room is
 * denied (`403 M_FORBIDDEN`), exactly the failure the spec's own prose
 * warned about, now confirmed against the real running module rather than
 * inferred from reading the code. This is a real, fixable gap (the fix
 * belongs in wallet-service's room-creation flow — a direct call to the
 * membership registry, or an equivalent server-side registration hook —
 * not in this test suite). See the Wave-2 report for triage.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mlDsa44GenerateKeypair, keccak256, deriveMatrixUserId } from '@membership-card-protocol/client-sdk';
import {
  SYNAPSE_BASE_URL,
  MATRIX_SERVER_NAME,
  registerMatrixUserViaSharedSecret,
  createCardGatedRoom,
  type RegisteredMatrixUser,
} from '../support/matrixAdmin.js';

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
      body: JSON.stringify({ msgtype: 'm.text', body: 'integration suite probe message' }),
    }
  );
}

describe('matrix_join_attestation_and_revocation.md (live stack)', () => {
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
  }, 30_000);

  describe('§2a Post-Time Identity Resolution', () => {
    // BUG, see this file's header comment: the spec explicitly warns this
    // must not happen ("their first post would have no registry entry to
    // resolve against" if the creator's auto-join isn't separately
    // registered) — confirmed live that it does happen. This test asserts
    // the CURRENT (buggy) behavior, not the spec's intended one, so it
    // stays a useful regression trip-wire rather than a permanently-red
    // test: if wallet-service's room-creation flow starts registering the
    // creator's membership, this assertion should flip to `.toBe(200)`
    // and this comment updated.
    it('[BUG, confirmed live] the room creator\'s own first post is denied — creator auto-join is never registered in the membership registry', async () => {
      const res = await sendTextMessage(roomId, creator.accessToken);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { errcode?: string };
      expect(body.errcode).toBe('M_FORBIDDEN');
    }, 15_000);

    it('a post from an account with no membership-registry entry at all is denied the same way (baseline, not creator-specific)', async () => {
      // A user who never joined this room, attempting to post directly —
      // Matrix's own membership check would normally catch this before
      // the policy module ever sees it (you can't /send to a room you
      // haven't joined), so this is really confirming Synapse's ordinary
      // membership requirement, not the module's own registry lookup
      // specifically. Included for contrast with the case above: THAT
      // denial is surprising (the account genuinely is a room member);
      // this one would be denied by any Matrix server, gated room or not.
      const strangerKeypair = mlDsa44GenerateKeypair();
      const { localpart } = localpartFor(strangerKeypair);
      const stranger = await registerMatrixUserViaSharedSecret(localpart);
      const res = await sendTextMessage(roomId, stranger.accessToken);
      expect(res.status).toBe(403);
    }, 15_000);
  });

  describe('Server-administrator-forced joins (documented, not this environment\'s to exercise)', () => {
    // matrix_join_attestation_and_revocation.md §2's "Server-administrator-
    // forced joins" paragraph describes force-joining a user via Synapse's
    // Admin API independently of any card-holder action, and states this
    // is *accepted, deliberate* dead-end behavior (no registry entry, deny
    // on next post) rather than a gap to close. Exercising this for real
    // needs a Synapse admin access token (a server-operator credential,
    // distinct from the shared-secret *registration* flow the rest of
    // this suite uses to create ordinary users) — this stack's compose
    // config doesn't provision one, and generating an ad hoc admin user
    // just to prove a documented-as-intentional dead end isn't worth the
    // extra surface. Left as a structural note, not an it.todo: unlike
    // this file's other gaps, this one is a deliberate, spec-documented
    // non-goal, not a bug or missing test infrastructure.
    it.todo('an admin-forced join produces no membership-registry entry and denies the account\'s next post — documented as intentional, not exercised in this environment');
  });
});
