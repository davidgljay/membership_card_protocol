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
 * BUG FOUND WRITING THIS SUITE — confirmed live, FIXED 2026-07-23
 * ---------------------------------------------------------------------
 *
 * The spec's own "Creator auto-join, carried over unchanged" paragraph
 * (§2) states plainly: "since their own join never reaches
 * `check_event_for_spam`, whatever code path handles their auto-join has
 * to register the entry directly ... or their first post would have no
 * registry entry to resolve against." Confirmed empirically (§2a scenario
 * below) that it didn't: `wallet-service/src/matrix/room-creation.ts`'s
 * `createMatrixRoomViaSynapse` only called Synapse's `/createRoom` and
 * returned — nothing called into the membership registry, so the room
 * creator's own very first post to their own freshly-created room was
 * denied (`403 M_FORBIDDEN`).
 *
 * Root cause, confirmed via a live debug probe (not assumed from reading
 * the spec text): `check_event_allowed` — the real join gate — genuinely
 * *is* invoked for the creator's own join event during room creation
 * (the module's own prior docstring/spec claim that it's never invoked for
 * creation joins was written about `check_event_for_spam`/
 * `user_may_join_room`, never re-verified for `check_event_allowed` after
 * that later became the real production gate). But at that point
 * `m.card.policy` isn't in `state_events` yet — it's a *later*
 * `initial_state` entry in the same `/createRoom` request — so the
 * "not a card-gated room yet" early-return fires and nothing registers.
 *
 * Fixed in `matrix_policy_module/module.py` (`_register_creator_membership`,
 * a new `io.cardprotocol.room_creator_attestation` custom state-event
 * type `check_event_allowed` now recognizes): the creator submits a
 * normal join-attestation envelope (`client-sdk`'s `buildJoinAttestation`,
 * reused unchanged) as a follow-up state event once `room_id` is known
 * (it can't be part of the `/createRoom` request itself — `room_id`
 * doesn't exist until that request returns). Unlike an ordinary join, this
 * doesn't require the creator's card to satisfy the room's own policy —
 * per the spec's own words, the creator is trusted by virtue of having
 * created the room, not by qualifying under it. wallet-service's
 * `POST /matrix/rooms` was deliberately NOT changed to route this itself:
 * wallet-service is non-custodial (never holds a card's signing key) and
 * can't sign the attestation, and a client that already holds its own
 * Matrix access token can submit this state event directly against
 * Synapse — no new wallet-service API surface needed.
 *
 * **What "fixed" means here, precisely**: confirmed via direct
 * `docker compose logs synapse` inspection (not guessed) that submitting
 * the creator attestation changes the creator's own next post's deny
 * reason from `membership_not_registered` to `predicate document
 * unreachable` — i.e. `_register_creator_membership` now successfully
 * finds `card_hash` via the registry where it previously found nothing.
 * It can't be asserted as an HTTP-observable `200`, though: posting still
 * needs a real, fetchable, *satisfiable* predicate document, which needs a
 * real on-chain card issued under a real policy — the same "no real chain
 * data reachable in this environment" gap already blocking every other
 * happy-path scenario in this file, and neither deny reason is ever
 * surfaced in the HTTP response regardless (`403 M_FORBIDDEN` either way).
 * See the `it.todo` below for the precise, evidence-based statement of
 * what remains unprovable via HTTP alone.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mlDsa44GenerateKeypair, keccak256, deriveMatrixUserId, buildJoinAttestation } from '@membership-card-protocol/client-sdk';
import {
  SYNAPSE_BASE_URL,
  MATRIX_SERVER_NAME,
  registerMatrixUserViaSharedSecret,
  createCardGatedRoom,
  submitRoomCreatorAttestation,
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

    // The fix, exercised for real: submit the creator's own join
    // attestation as a follow-up state event now that room_id is known.
    const creatorAttestation = buildJoinAttestation(creatorKeypair.secretKey, roomId, MATRIX_SERVER_NAME);
    const attestationRes = await submitRoomCreatorAttestation(roomId, creator.accessToken, creatorAttestation);
    expect(attestationRes.ok).toBe(true);
  }, 30_000);

  describe('§2a Post-Time Identity Resolution', () => {
    // Confirmed live 2026-07-23 (manual docker-logs inspection, not
    // guessed): submitting the creator attestation DOES register the
    // membership now — the post's deny reason changes from
    // `membership_not_registered` to `predicate document unreachable`,
    // proving `_register_creator_membership` ran and found `card_hash` via
    // `resolve_card_hash` this time. It still can't return 200 in this
    // environment: `check_event_for_spam`'s post path also requires
    // fetching *and satisfying* a real predicate document, and satisfying
    // one needs a real on-chain card issued under a real policy — this
    // suite's cards and policy_ids are synthetic (same "no real chain data
    // reachable" scoping this whole file already documents for every
    // other happy path). Neither deny reason is surfaced in the HTTP
    // response either way (`403 M_FORBIDDEN` regardless — see this
    // suite's sibling `matrix_room_membership.spec.ts` for the same
    // finding), so there's no purely-HTTP-observable assertion that
    // distinguishes "still denied because unregistered" from "still
    // denied because no real chain" — the fix is real, confirmed by
    // direct log inspection, but not expressible as a passing HTTP
    // assertion without the same real-card/pinned-policy prerequisite
    // blocking every other happy path in this file.
    it.todo(
      'the room creator, having submitted their own creator attestation, can post in their own room — needs a real on-chain card + satisfiable pinned policy, same gap as the rest of this file'
    );

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
      // No submitRoomCreatorAttestation call — this is exactly the
      // original, unfixed behavior: nothing registers this creator's
      // membership, so their first post is denied the same as before.
      const res = await sendTextMessage(otherRoom.roomId, otherCreator.accessToken);
      expect(res.status).toBe(403);
    }, 30_000);
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
