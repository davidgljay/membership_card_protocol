import type { ObliviousProtocolTransport } from '../providers/ObliviousProtocolTransport.js';
import type { OpenOfferClaimSubmission } from './countersign.js';

/**
 * `SCIP` (Signed Card Inclusion Proof) — `protocol-objects.md §10`.
 * Produced by the press, delivered to the recipient, retained as
 * verifiable proof of issuance. This module only parses and returns it;
 * verifying `press_signature` is out of this step's scope.
 */
export interface Scip {
  card_cid: string;
  policy_log_entry_index: number;
  policy_log_root_at_inclusion: string;
  issued_at: string;
  press_signature: { public_key: string; signature: string };
}

export interface SubmitOpenOfferClaimResult {
  cardCid: string;
  scip: Scip;
}

interface OpenOfferClaimResponseBody {
  card_cid: string;
  scip: Scip;
}

/**
 * `POST /open-offer/claim` (`press.md §4`, `§5.2 processOpenOfferClaim`) —
 * routed through `ObliviousProtocolTransport` targeting the offer's named
 * press, per `open_offer_acceptance_new_wallet.md §Phase 3` Step 15 and
 * `plans/client-sdk/strategic-plan.md §Goal 7` (the press never sees the
 * device's IP, only the relay's).
 */
export async function submitOpenOfferClaim(
  transport: ObliviousProtocolTransport,
  press: { baseUrl: string },
  claimSubmission: OpenOfferClaimSubmission
): Promise<SubmitOpenOfferClaimResult> {
  const response = await transport.request(
    { kind: 'press', baseUrl: press.baseUrl },
    {
      method: 'POST',
      path: '/open-offer/claim',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify(claimSubmission)),
    }
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`submitOpenOfferClaim: POST /open-offer/claim returned status ${response.status}`);
  }

  const body = JSON.parse(new TextDecoder().decode(response.body)) as OpenOfferClaimResponseBody;
  return { cardCid: body.card_cid, scip: body.scip };
}
