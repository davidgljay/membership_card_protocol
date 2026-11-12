/**
 * `@membership-card-protocol/wallet-sdk/notary-types` — side-effect-free subpath for the notary
 * host (Q4): the §21–§26 types plus the canonical/hash helpers. Imports nothing from the rest of
 * the wallet, so the host does not pull in the SDK's providers.
 */
export type * from "./types.js";
export {
  canonicalNotary, parseCanonicalNotary, H, hBytes, b64uEncode, b64uDecode, withoutFields, assertNotaryObject,
  cardPointer, cidOfBytes, digestFromCid, NotaryFormatError,
} from "@membership-card-protocol/verifier/notary";
