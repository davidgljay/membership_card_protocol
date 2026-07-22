/**
 * A permissive test policy document (`specs/object_specs/press.md`
 * `PolicyDocument` shape) for minting fixture cards against the live
 * stack's press.
 *
 * Deliberately has no `requester_predicate`/`recipient_predicate` — press's
 * `validateIssuanceRequest` only evaluates predicates when the request
 * carries a `recipient_card_address` (targeted issuance to an *existing*
 * card; see `press/src/functions/issuance.ts`). Fixture cards are minted to
 * a brand-new holder with no prior card, so no predicate ever runs for
 * them regardless of what's configured here — omitting them keeps this
 * fixture honest about what it actually exercises, rather than declaring
 * constraints that are silently never checked.
 */

/**
 * Mirrors press's own `PolicyDocument` (`press/src/types.ts`) — press is a
 * private app, not a published package, so this shape is duplicated rather
 * than imported. Keep in sync if that shape changes.
 */
export interface PolicyDocument {
  policy_id: string;
  field_definitions: Record<string, { type: string; required?: boolean }>;
  approved_presses: string[];
  allow_open_offers?: boolean;
  [key: string]: unknown;
}

/**
 * @param pressCardCid The press's own `PRESS_CARD_CID` (must appear in
 *   `approved_presses` for `POST /issue` to accept an offer against this
 *   policy — see `press/src/functions/issuance.ts`'s step 4).
 */
export function buildPermissiveTestPolicy(pressCardCid: string): PolicyDocument {
  return {
    policy_id: 'integration-fixture-policy',
    field_definitions: {
      display_name: { type: 'string', required: false },
    },
    approved_presses: [pressCardCid],
    allow_open_offers: true,
  };
}
