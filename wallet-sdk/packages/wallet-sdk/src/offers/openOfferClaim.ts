import type { ObliviousProtocolTransport, Scip } from '@membership-card-protocol/app-sdk';
import type { OpenOfferClaimSubmission } from './countersign.js';

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
 *
 * Wallet-only: the wallet-side claim-submission function App SDK's own
 * `offers/targetedOfferAcceptance.ts` explicitly does not implement (App
 * SDK owns only offer construction and offerer-side press finalization).
 * `Scip` is imported from App SDK rather than redefined here — it's a pure
 * data shape shared by both packages (App SDK's offerer-side
 * `targetedOfferAcceptance.ts` and this module).
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
