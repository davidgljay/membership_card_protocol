import { evaluatePolicyMatch } from '@membership-card-protocol/verifier';
import type { ChainLink, PolicyMatchConditions, SignedMessageEnvelope, EnvelopeVerificationResult } from '@membership-card-protocol/verifier';

/**
 * Client-side room discovery — key-independent half (Matrix Phase 4, Step
 * 16b — `room_discovery.md §2`). Originally ported into `client-sdk`, now
 * split out of that deprecated package: the predicate-evaluation logic and
 * shared types below need no private key and live here in `app-sdk`; the
 * signing half (`buildRoomDiscoveryEnvelope`, `discoverRooms`, both of which
 * take a card's secret key directly) lives in `wallet-sdk`'s
 * `matrix/discovery.ts` and imports {@link evaluateRoomPredicate} from here.
 */

/**
 * Minimal shape `wallet-sdk`'s `discoverRooms` needs from a chain-walking
 * verifier — typed against this interface (not the concrete `CardVerifier`
 * class) so callers/tests can supply anything that can answer "what's this
 * card's chain," without depending on `CardVerifier`'s private internals.
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
 * hand-written field-matching reimplementation. `evaluatePolicyMatch`
 * returns a `PolicyMatchResult | null` (reason codes added for
 * observability, not a plain boolean) — `null` (conditions not supplied —
 * can't happen here since every entry always supplies a `policy_id`) or
 * `{ matched: false, ... }` is treated as non-matching; "no entry matched"
 * denies, per this module's deny-by-default posture.
 */
export function evaluateRoomPredicate(
  predicateDocument: RoomPredicateDocument,
  chain: ChainLink[]
): boolean {
  for (const entry of predicateDocument.policies ?? []) {
    if (evaluatePolicyMatch(chain, entryConditions(entry))?.matched === true) {
      return true;
    }
  }
  return false;
}
