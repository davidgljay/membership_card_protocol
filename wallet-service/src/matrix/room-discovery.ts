/**
 * Server-hosted room discovery (specs/process_specs/room_discovery.md §3;
 * matrix-implementation-plan.md Phase 4 Step 16c). Backs
 * `POST /matrix/discover-rooms` — the secondary/fallback path for clients
 * that can't run a local RPC/IPFS chain-walk themselves.
 *
 * **Corrected 2026-07-12 — a real, shipped bug, not a style fix (same root
 * cause as client-sdk's `discoverRooms`, `client-sdk/packages/client-sdk/
 * src/matrix/discovery.ts`).** This originally took a bare `cardHash` and
 * called `cardVerifier.verifyCard(cardHash)`, expecting `.chain` to come
 * back populated. It never could: `CardVerifier.verifyCard()` hardcodes an
 * empty chain unconditionally — it has no pubkey for a bare address, so it
 * can never decrypt that card's `CardDocument`. Every card was reported
 * ineligible for every room, unconditionally.
 *
 * **This endpoint's fix is not simply "call verifyEnvelope instead," the
 * way client-sdk's was — this server never holds a card's private key, so
 * it cannot construct or sign an envelope itself.** The caller (an
 * authenticated card holder) must submit an already-signed envelope in the
 * request body — the exact same envelope `client-sdk`'s (now-corrected)
 * `discoverRooms` builds for itself via the exported
 * `buildRoomDiscoveryEnvelope` (`client-sdk/packages/client-sdk/src/matrix/
 * discovery.ts`). This is a sound fit for this endpoint's own stated
 * purpose: it exists for clients that can't do a local **RPC/IPFS**
 * chain-walk, not clients that can't **sign** — signing needs only the
 * local private key, no network access at all, so a constrained client can
 * still build this envelope itself and submit just that, letting the
 * server do the (RPC/IPFS-heavy) chain-walk on its behalf.
 *
 * Verification here does two checks beyond the verifier's own chain-walk,
 * mirroring the same sender-binding discipline
 * `matrix-policy-module/src/matrix_policy_module/attestation.py` already
 * uses for join attestations — never trust a claimed identity at face
 * value when the actual verified value is available:
 * 1. `signatures[0].signature_valid` must be `true` — a syntactically
 *    present but cryptographically invalid signature is rejected, not
 *    silently passed through to the chain-walk (`CardVerifier.verifyEnvelope`
 *    itself does not gate later stages on this — see this module's own
 *    `InvalidDiscoveryEnvelopeError` handling below, not an assumption
 *    baked into the verifier package).
 * 2. `signatures[0].signer_card` (the verifier's own recovered
 *    `keccak256(public_key)`, not re-derived independently here) must equal
 *    the authenticated session's own `card_hash` — a card holder cannot
 *    submit a different card's envelope to probe its eligibility while
 *    authenticated as themselves.
 *
 * This runs the *identical* predicate-evaluation algorithm as client-sdk's
 * `discoverRooms` (Step 16b) once a verified chain is in hand:
 *   1. Verify the submitted envelope (above).
 *   2. For each room-index entry (already in hand here — the server reads
 *      its own `matrix_room_index` table via `db/matrix-rooms.ts`'s
 *      `listRoomIndex` rather than looping back through its own
 *      `GET /matrix/room-index` HTTP endpoint), fetch the predicate
 *      document from IPFS by CID.
 *   3. Evaluate it against the chain via `evaluateRoomPredicate` and
 *      collect the eligible `room_id`s.
 *
 * **`evaluateRoomPredicate` is ported here, not imported from
 * `client-sdk`.** `client-sdk` isn't set up as a server-importable
 * dependency of `wallet-service` — it's published for holder-side/browser
 * use (key custody, offer acceptance, messaging) and `wallet-service`'s
 * `package.json` has no dependency on it (nor does any other file in this
 * service import from it). Pulling in the whole package here to reuse one
 * ~10-line function would be backwards — it would make a server process
 * depend on a client-identity-custody library it has no other reason to
 * load. Instead this ports exactly the same thin `any_of` loop client-sdk's
 * `evaluateRoomPredicate` uses, calling the same shared, already-a-
 * dependency-of-wallet-service `evaluatePolicyMatch` from
 * `@membership-card-protocol/verifier` for the actual field-matching
 * logic — never a hand-written reimplementation of exact-match/regex
 * semantics. This is the same discipline `predicates.py` (the Synapse
 * policy module's own evaluator, `matrix-policy-module/src/
 * matrix_policy_module/predicates.py`) already follows in Python: a thin
 * loop over the shared verifier package's `evaluate_policy_match`, not a
 * parallel reimplementation. All three implementations (Python, client-sdk
 * TS, this file) now share the same one true field-matching primitive and
 * only duplicate the trivial any_of loop around it — see
 * matrix-strategic-plan.md Goal 2 on why a duplicated *evaluator* would be
 * the thing to avoid, not a duplicated one-line loop that calls into it.
 *
 * **Privacy posture (room_discovery.md §3):** unlike the client-side path,
 * this endpoint legitimately learns `card_hash` (it's the authenticated
 * caller's own session) — that's the documented, accepted trade-off of
 * using this fallback endpoint at all. What it must *not* do is keep a
 * durable record of *which rooms* a card asked about, beyond a short-window
 * abuse-rate-limit counter. This module makes no writes of any kind — no
 * database call, no KV call — it is a pure read-and-compute function; the
 * route handler (`server/routes/matrix/discover-rooms.post.ts`) is
 * responsible for the (KV-backed, TTL'd) rate-limit check, and performs no
 * other write either.
 */

import {
  evaluatePolicyMatch,
  type ChainLink,
  type EnvelopeVerificationResult,
  type PolicyMatchConditions,
  type SignedMessageEnvelope,
} from '@membership-card-protocol/verifier';

/**
 * Minimal chain-walking interface, mirroring client-sdk's
 * `CardChainVerifier` (`discovery.ts`) — deliberately not the concrete
 * `CardVerifier` class, so callers/tests can supply anything that can
 * answer "what's this chain" without depending on `CardVerifier`'s private
 * internals. See `card-chain-verifier.ts` in this directory for the
 * production wiring (and its current gap).
 */
export interface CardChainVerifier {
  verifyEnvelope(envelope: SignedMessageEnvelope): Promise<EnvelopeVerificationResult>;
}

export interface RoomIndexEntryLite {
  room_id: string;
  policy_id: string;
}

/** `matrix_room.md §The Room Predicate Document` — a flat `policies` list, `any_of`'d. */
export interface RoomPredicatePolicyEntry {
  ref_type: 'cid' | 'pointer';
  ref: string;
  /** Present only on `pointer`-originated entries; this, not `ref`, is what's actually evaluated. */
  resolved_ref?: string;
  field_match?: { field: string; regex: string };
}

export interface RoomPredicateDocument {
  policies: RoomPredicatePolicyEntry[];
}

/**
 * Thrown when the submitted envelope's signature doesn't verify, or its
 * recovered `signer_card` doesn't match the authenticated session's own
 * `card_hash`. The route maps this to a 4xx — never treated as "zero
 * eligible rooms," which would look identical to a legitimate empty result.
 */
export class InvalidDiscoveryEnvelopeError extends Error {}

function entryConditions(entry: RoomPredicatePolicyEntry): PolicyMatchConditions {
  const policyId = entry.resolved_ref ?? entry.ref;
  const fieldMatch = entry.field_match
    ? { [entry.field_match.field]: { regex: entry.field_match.regex } }
    : undefined;
  return { policy_id: policyId, ...(fieldMatch ? { field_match: fieldMatch } : {}) };
}

/**
 * `predicates.py`'s `evaluate_room_predicate` / client-sdk's
 * `evaluateRoomPredicate`, ported: true if the chain was issued under *any*
 * policy entry in the room's predicate document (and satisfies that
 * entry's `field_match`, if present). An entry whose `evaluatePolicyMatch`
 * returns `false` (or, in principle, `null` — can't happen here since every
 * entry always supplies a `policy_id`) is treated as non-matching; "no
 * entry matched" denies, per this endpoint's deny-by-default posture.
 */
export function evaluateRoomPredicate(predicateDocument: RoomPredicateDocument, chain: ChainLink[]): boolean {
  for (const entry of predicateDocument.policies ?? []) {
    if (evaluatePolicyMatch(chain, entryConditions(entry)) === true) {
      return true;
    }
  }
  return false;
}

export interface DiscoverEligibleRoomsOptions {
  /** Injectable `fetch`, primarily for testing. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

function joinUrl(base: string, cid: string): string {
  return `${base.replace(/\/+$/, '')}/${cid}`;
}

async function fetchPredicateDocument(
  policyId: string,
  ipfsGatewayUrl: string,
  fetchImpl: typeof fetch
): Promise<RoomPredicateDocument | null> {
  try {
    const response = await fetchImpl(joinUrl(ipfsGatewayUrl, policyId), { method: 'GET' });
    if (!response.ok) return null;
    return (await response.json()) as RoomPredicateDocument;
  } catch {
    return null;
  }
}

/**
 * Runs room_discovery.md §3's algorithm end-to-end, server-side:
 * 1. Verify the caller-submitted, already-signed envelope via
 *    `cardVerifier.verifyEnvelope` — this is what actually populates a real
 *    chain (see this module's header comment for why `verifyCard` cannot,
 *    and why the server cannot build the envelope itself).
 * 2. Confirm the envelope's signature is genuinely valid and its recovered
 *    `signer_card` matches the authenticated session's `expectedCardHash` —
 *    throws `InvalidDiscoveryEnvelopeError` otherwise.
 * 3. For each `{room_id, policy_id}` entry already read from the room
 *    index (the caller passes these in — see `db/matrix-rooms.ts`'s
 *    `listRoomIndex`), fetch its predicate document from IPFS and
 *    evaluate it against the chain via `evaluateRoomPredicate`.
 * 4. Return the eligible `room_id`s.
 *
 * A predicate document that fails to fetch or parse is skipped (treated
 * as non-matching for that room), not a hard failure of the whole
 * discovery call — identical behavior to client-sdk's `discoverRooms`,
 * so the two implementations agree on every input, not just the happy path.
 */
export async function discoverEligibleRooms(
  envelope: SignedMessageEnvelope,
  expectedCardHash: string,
  roomIndex: RoomIndexEntryLite[],
  ipfsGatewayUrl: string,
  cardVerifier: CardChainVerifier,
  options: DiscoverEligibleRoomsOptions = {}
): Promise<string[]> {
  const fetchImpl = options.fetchImpl ?? fetch;

  const verification = await cardVerifier.verifyEnvelope(envelope);
  const signatureResult = verification.signatures[0];
  if (!signatureResult || signatureResult.signature_valid !== true) {
    throw new InvalidDiscoveryEnvelopeError('room-discovery envelope signature did not verify.');
  }
  if (signatureResult.signer_card !== expectedCardHash) {
    throw new InvalidDiscoveryEnvelopeError(
      "room-discovery envelope's signer_card does not match the authenticated session's card_hash."
    );
  }
  const chain = signatureResult.chain ?? [];

  const eligibleRoomIds: string[] = [];
  for (const entry of roomIndex) {
    const predicateDocument = await fetchPredicateDocument(entry.policy_id, ipfsGatewayUrl, fetchImpl);
    if (predicateDocument === null) continue;
    if (evaluateRoomPredicate(predicateDocument, chain)) {
      eligibleRoomIds.push(entry.room_id);
    }
  }

  return eligibleRoomIds;
}
