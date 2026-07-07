import { CardVerifier } from '@membership-card-protocol/verifier';
import type { IpfsProvider, VerifierConfig } from '@membership-card-protocol/verifier';
import { FilebaseIpfsProvider } from '@membership-card-protocol/verifier-ipfs-provider';

/**
 * Constructs the single shared `CardVerifier` instance the SDK uses for
 * every chain-walk, revocation-check, and signature-verification point the
 * specs call for (offer issuer chain, press on-chain authorization,
 * inbound message sender chain, and — from Phase 4 on — the app-card
 * certification chain for sub-card requests). Mirrors the pattern
 * `press.md §5.0` already uses server-side: one instance, constructed at
 * initialization, reused across every verification call. The SDK never
 * reimplements chain-walking, revocation-checking, or policy-compliance
 * logic independently — every result returned by this instance is surfaced
 * to callers unmodified (Goal 6).
 *
 * `rpc` is required and always host-app-supplied: it wraps whichever
 * Arbitrum One RPC client (viem, ethers, or another) the host app already
 * configures. Deliberately not defaulted or bundled here — forcing a
 * specific chain-client library on every client-sdk consumer would
 * contradict Goal 6's "no bundled ethers/viem version forced on the
 * consuming app beyond what the provider needs". A host app that wants a
 * ready-made `RpcProvider` can use
 * `@membership-card-protocol/verifier-rpc-provider` (ethers v6) directly
 * and pass the result here.
 *
 * `ipfs` defaults to `FilebaseIpfsProvider` from
 * `@membership-card-protocol/verifier-ipfs-provider` (no required
 * configuration, plain `fetch`-based, browser/RN-friendly) — the one
 * companion package this factory does bundle, since it has no forced
 * dependency of its own. Callers may override it (e.g. to point at a
 * dedicated gateway) by supplying `ipfs` explicitly.
 */
export interface CreateCardVerifierOptions extends Omit<VerifierConfig, 'ipfs'> {
  ipfs?: IpfsProvider;
}

export function createCardVerifier(options: CreateCardVerifierOptions): CardVerifier {
  const { ipfs, ...rest } = options;
  return new CardVerifier({
    ...rest,
    ipfs: ipfs ?? new FilebaseIpfsProvider(),
  });
}

export { CardVerifier };
export type {
  RpcProvider,
  IpfsProvider,
  VerifierConfig,
  CardEntry,
  CardDocument,
  SubCardDocument,
  SignedMessageEnvelope,
  SignatureEntry,
  VerifyCardOptions,
  EnvelopeVerificationResult,
  SignatureVerificationResult,
  CardVerificationResult,
} from '@membership-card-protocol/verifier';
