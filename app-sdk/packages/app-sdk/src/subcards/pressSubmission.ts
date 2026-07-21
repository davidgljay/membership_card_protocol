import type { ObliviousProtocolTransport } from '../providers/ObliviousProtocolTransport.js';
import type { RegisterSubCardFn, SignedSubCardDocument } from './types.js';

/**
 * Press submission for a completed `SubCardDocument`
 * (`subcards.md §Sub-Card Request Flow Step 5`; `press.md §5.4
 * processSubCardRegistration`) — `POST /sub-card/register`, routed
 * through `ObliviousProtocolTransport` like every other press-facing call
 * this package makes (`plans/client-sdk/strategic-plan.md §Goal 7`).
 *
 * This is the real implementation of the press-submission flow that
 * Wallet SDK's own device sub-card self-registration and its granter-side
 * countersign flow both take as an injected `RegisterSubCardFn` dependency
 * rather than talking to the press directly. `createPressSubCardRegistrar`
 * adapts {@link submitSubCardRegistration}'s richer result to that exact
 * callback shape, so callers can pass a real registrar into either flow
 * instead of a test double.
 */

export interface SubmitSubCardRegistrationOptions {
  transport: ObliviousProtocolTransport;
  /** The press to submit through (per policy, the same press the sub-card's `holder_primary_card` chain is registered under, or any press approved for that policy). */
  pressBaseUrl: string;
}

export interface SubCardRegistrationResult {
  subCardDocCid: string;
  txHash: string;
}

interface SubCardRegisterResponseBody {
  sub_card_doc_cid: string;
  tx_hash: string;
}

/**
 * Press's `/sub-card/register` body shape (`press.md §5.4
 * processSubCardRegistration(subCardDoc, holderSignature, ...)`): the doc
 * and the holder's countersignature are separate top-level fields —
 * `sub_card_document` (which still carries `app_signature`) and a sibling
 * `holder_signature` — rather than the single flat object
 * `SignedSubCardDocument` uses internally. Both signatures stay plain
 * base64url strings on the wire, matching what `requestSubCard.ts`/
 * `countersign.ts` actually canonicalize and sign over.
 */
interface SubCardRegisterRequestBody {
  sub_card_document: Omit<SignedSubCardDocument, 'holder_signature'>;
  holder_signature: string;
}

function toPressRequestBody(document: SignedSubCardDocument): SubCardRegisterRequestBody {
  const { holder_signature, ...sub_card_document } = document;
  return { sub_card_document, holder_signature };
}

/** `POST /sub-card/register`. Throws on a non-2xx response — unlike {@link createPressSubCardRegistrar}, which swallows failure into `{ registered: false }` to match `RegisterSubCardFn`'s shape. */
export async function submitSubCardRegistration(
  document: SignedSubCardDocument,
  options: SubmitSubCardRegistrationOptions
): Promise<SubCardRegistrationResult> {
  const response = await options.transport.request(
    { kind: 'press', baseUrl: options.pressBaseUrl },
    {
      method: 'POST',
      path: '/sub-card/register',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify(toPressRequestBody(document))),
    }
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`submitSubCardRegistration: POST /sub-card/register returned status ${response.status}`);
  }

  const body = JSON.parse(new TextDecoder().decode(response.body)) as SubCardRegisterResponseBody;
  return { subCardDocCid: body.sub_card_doc_cid, txHash: body.tx_hash };
}

/**
 * Adapts {@link submitSubCardRegistration} to the `RegisterSubCardFn`
 * shape `registerDeviceSubCard`/`countersignSubCardRequest` expect —
 * `{ registered: boolean }` only, swallowing a rejected submission into
 * `registered: false` rather than throwing, since those callers treat a
 * failed registration as a normal (if unwelcome) outcome to report, not an
 * exceptional one.
 */
export function createPressSubCardRegistrar(options: SubmitSubCardRegistrationOptions): RegisterSubCardFn {
  return async (document: SignedSubCardDocument) => {
    try {
      await submitSubCardRegistration(document, options);
      return { registered: true };
    } catch {
      return { registered: false };
    }
  };
}
