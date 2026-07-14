import {
  PROTOCOL_VERSION_0_1,
  evaluatePolicyMatch,
} from '@membership-card-protocol/verifier';
import type {
  ChainLink,
  EnvelopeVerificationResult,
  PolicyMatchConditions,
  SignedMessageEnvelope,
} from '@membership-card-protocol/verifier';
import { canonicalize } from '../crypto/canonicalize.js';
import { mlDsa44GetPublicKey, mlDsa44Sign } from '../crypto/mldsa.js';
import { bytesToBase64Url } from '../util/base64url.js';

/**
 * Client-side room discovery (Matrix Phase 4, Step 16b — `room_discovery.md
 * §2`). A card holder should be able to figure out which existing card-gated
 * Matrix rooms their card qualifies for, using only public data — no server
 * ever needs to learn which card is asking about which rooms.
 *
 * ```
 * discoverRooms(cardSecretKey, roomIndexUrl, ipfsGatewayUrl, cardVerifier) -> [room_id, ...]
 * ```
 *
 * **Corrected 2026-07-12 — a real, shipped bug, not a style fix.** The
 * original version of this function took a bare `cardHash` and called
 * `cardVerifier.verifyCard(cardHash)`, expecting `.chain` to come back
 * populated. It never could: `CardVerifier.verifyCard()` hardcodes
 * `chain: []` unconditionally — it has no pubkey for a bare address, so it
 * can never decrypt that card's `CardDocument` to walk ancestry, regardless
 * of `returnChain` config (confirmed identical in the Python port's
 * `verify_card()` — this is a correct, intentional limitation of that
 * function, not itself a bug). The consequence: `discoverRooms` always
 * received an empty chain, so `evaluateRoomPredicate` always evaluated
 * `false`, so **every card was reported ineligible for every room,
 * unconditionally** — a total functional failure that 12/12 passing tests
 * didn't catch, because the test suite mocked `verifyCard` to directly
 * return a fabricated chain rather than exercising the real `CardVerifier`.
 *
 * **The fix:** a card holder discovering rooms for their own card always
 * holds that card's private key — this is the same situation the
 * join-attestation chain-walk (Step 10/12) is already in, and it correctly
 * solves it by signing a minimal statement and calling
 * `CardVerifier.verifyEnvelope()`, not `verifyCard()` — `verifyEnvelope`
 * *does* populate a real chain (Stage 3), since the envelope's signature
 * carries the pubkey needed to decrypt the card's document. This function
 * now takes the card's secret key directly, builds a minimal self-signed
 * envelope (canonicalized + ML-DSA-44 signed the same way
 * `messaging/envelope.ts` signs real message envelopes), and calls
 * `verifyEnvelope` instead. **Do not "simplify" this back to `verifyCard`
 * with a bare hash — that is precisely the bug this comment documents.**
 * See `plans/membership_card_verifier_todo.md` item 2 for the long-term
 * fix (giving `verifyCard`/`verify_card` an optional pubkey/document input
 * so it can also return a real chain) — not done today, this call site
 * works around it by using the entry point that already supports it.
 *
 * **Judgment call retained from the original version:** `room_discovery.md
 * §2` writes the signature with a bare `arbitrum_rpc` argument; this module
 * still accepts an already-constructed chain-walking verifier
 * (`cardVerifier`) instead of a raw RPC URL, for the same reason
 * `CardVerifier.ts` never bundles or defaults RPC access — see that file's
 * header comment. The parameter is typed against the minimal
 * `CardChainVerifier` interface below (not the concrete `CardVerifier`
 * class) purely so callers/tests can supply anything that can answer
 * "what's this card's chain," without this module depending on
 * `CardVerifier`'s private internals.
 *
 * **Privacy constraint (the entire point of this being a client-side
 * function rather than a server endpoint, per `room_discovery.md §2`):** no
 * network call this function makes may be authenticated or bound to the
 * card's identity.
 * - The room index fetch (`roomIndexUrl`) is a plain, anonymous GET —
 *   identical for every requester, no card-identifying data in the URL,
 *   query string, headers, or body.
 * - Each predicate-document fetch is a plain GET by CID against
 *   `ipfsGatewayUrl` — again, no card-identifying data anywhere in the
 *   request.
 * - The chain-walk (`cardVerifier.verifyEnvelope`) is expected to resolve
 *   from the verifier's own already-configured RPC/IPFS providers, not by
 *   sending anything identity-bound to a third party over the network on
 *   this function's behalf. The self-signed envelope itself never leaves
 *   this function — it's constructed and verified entirely locally.
 */
export interface CardChainVerifier {
  verifyEnvelope(envelope: SignedMessageEnvelope): Promise<EnvelopeVerificationResult>;
}

export interface RoomIndexEntry {
  room_id: string;
  policy_id: string;
  created_at: string;
}

export interface RoomIndexResponse {
  rooms: RoomIndexEntry[];
  updated_at: string;
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

export interface DiscoverRoomsOptions {
  /**
   * Injectable `fetch`, primarily for testing. Defaults to `globalThis.fetch`.
   * Whatever is supplied here must not attach credentials, cookies, or any
   * card-identity-derived header to outgoing requests — see this module's doc.
   */
  fetchImpl?: typeof fetch;
  /** Injectable timestamp, primarily for testing. Defaults to `new Date().toISOString()`. */
  now?: () => string;
}

function joinUrl(base: string, cid: string): string {
  return `${base.replace(/\/+$/, '')}/${cid}`;
}

function entryConditions(entry: RoomPredicatePolicyEntry): PolicyMatchConditions {
  const policyId = entry.resolved_ref ?? entry.ref;
  const fieldMatch = entry.field_match
    ? { [entry.field_match.field]: { regex: entry.field_match.regex } }
    : undefined;
  return { policy_id: policyId, ...(fieldMatch ? { field_match: fieldMatch } : {}) };
}

/**
 * `predicates.py`'s `evaluate_room_predicate`, ported: a thin `any_of` loop
 * over the predicate document's `policies` list, each entry evaluated via
 * the verifier package's own exported `evaluatePolicyMatch` — never a
 * hand-written field-matching reimplementation. An entry whose
 * `evaluatePolicyMatch` returns `null` (conditions not supplied — can't
 * happen here since every entry always supplies a `policy_id`) or `false` is
 * treated as non-matching; "no entry matched" denies, per this module's
 * deny-by-default posture.
 */
export function evaluateRoomPredicate(
  predicateDocument: RoomPredicateDocument,
  chain: ChainLink[]
): boolean {
  for (const entry of predicateDocument.policies ?? []) {
    if (evaluatePolicyMatch(chain, entryConditions(entry)) === true) {
      return true;
    }
  }
  return false;
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
 * Builds and signs a minimal, self-contained statement purely to drive
 * `CardVerifier.verifyEnvelope`'s chain walk — this is not a real protocol
 * message (no recipients, not persisted) and deliberately doesn't reuse
 * `messaging/envelope.ts`'s `MessageType`-typed builders, which carry fields
 * (recipients/senders) this local-only statement has no use for.
 * Canonicalization and signing are the same primitives real message
 * envelopes use (`canonicalize`, `mlDsa44Sign`) — only the payload shape is
 * intentionally minimal.
 *
 * **Exported (not just an internal helper)** because `wallet-service`'s
 * server-hosted discovery fallback (`POST /matrix/discover-rooms`,
 * `room_discovery.md §3`) needs the exact same envelope: that endpoint
 * exists for clients that can't run a local RPC/IPFS chain-walk, but
 * *signing* needs neither — only the local private key — so such a client
 * still builds and signs this envelope itself and submits it to the
 * fallback endpoint, rather than the server fabricating one it structurally
 * cannot (the server never holds a card's private key).
 */
export function buildRoomDiscoveryEnvelope(
  cardSecretKey: Uint8Array,
  now: () => string = () => new Date().toISOString()
): SignedMessageEnvelope {
  const publicKey = mlDsa44GetPublicKey(cardSecretKey);
  const payload = {
    message: 'room-discovery-chain-walk',
    protocol_version: PROTOCOL_VERSION_0_1,
    timestamp: now(),
  };
  const signature = mlDsa44Sign(cardSecretKey, canonicalize(payload));
  return {
    payload,
    signatures: [
      {
        public_key: bytesToBase64Url(publicKey),
        signature: bytesToBase64Url(signature),
      },
    ],
  };
}

/**
 * Runs `room_discovery.md §2`'s algorithm end-to-end:
 * 1. Build and verify a minimal self-signed envelope for this card via
 *    `cardVerifier.verifyEnvelope` — this is what actually populates a real
 *    chain (see this module's header comment for why `verifyCard` cannot).
 * 2. Fetch the anonymous, unauthenticated room index.
 * 3. For each `{room_id, policy_id}` entry, fetch its predicate document
 *    from IPFS and evaluate it against the chain via `evaluateRoomPredicate`.
 * 4. Return the eligible `room_id`s.
 *
 * A predicate document that fails to fetch or parse is treated as
 * non-matching for that room (skipped), not a hard failure of the whole
 * discovery call — one unreachable room's policy shouldn't block finding
 * every other eligible room.
 */
export async function discoverRooms(
  cardSecretKey: Uint8Array,
  roomIndexUrl: string,
  ipfsGatewayUrl: string,
  cardVerifier: CardChainVerifier,
  options: DiscoverRoomsOptions = {}
): Promise<string[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date().toISOString());

  const envelope = buildRoomDiscoveryEnvelope(cardSecretKey, now);
  const verification = await cardVerifier.verifyEnvelope(envelope);
  const chain = verification.signatures[0]?.chain ?? [];

  const indexResponse = await fetchImpl(roomIndexUrl, { method: 'GET' });
  if (!indexResponse.ok) {
    throw new Error(`failed to fetch room index (${indexResponse.status}): ${roomIndexUrl}`);
  }
  const index = (await indexResponse.json()) as RoomIndexResponse;

  const eligibleRoomIds: string[] = [];
  for (const entry of index.rooms) {
    const predicateDocument = await fetchPredicateDocument(entry.policy_id, ipfsGatewayUrl, fetchImpl);
    if (predicateDocument === null) continue;
    if (evaluateRoomPredicate(predicateDocument, chain)) {
      eligibleRoomIds.push(entry.room_id);
    }
  }

  return eligibleRoomIds;
}
