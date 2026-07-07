/**
 * Shared `SubCardDocument`-family shapes (`subcards.md`, `protocol-objects.md
 * §16`) used by both the requester-side flow this package implements
 * (`requestSubCard.ts`) and the press-registration flow
 * (`pressSubmission.ts`). These are pure protocol data shapes — no key
 * material, no signing logic — so they live here rather than in any
 * custody-owning module. Wallet SDK's granter-side authorization flow
 * imports these same types from this package rather than redefining them,
 * matching the dependency direction (Wallet SDK depends on App SDK, never
 * the reverse).
 */

export interface SubCardDocumentFields {
  holder_primary_card: string;
  holder_primary_card_pubkey: string;
  app_card: string;
  app_card_pubkey: string;
  capabilities: string[];
  recipient_pubkey: string;
  issued_at: string;
  valid_until?: string;
  attestation_level: 'T1' | 'T2';
  attestation_proof?: string;
}

export interface SignedSubCardDocument extends SubCardDocumentFields {
  app_signature: string;
  holder_signature: string;
}

/**
 * An app's own governance-certified app-card identity (`subcards.md`: "The
 * wallet is itself an app — it has its own app card and creates its own
 * sub-cards"). Any requesting app — including a wallet acting as its own
 * requester — supplies one of these: a fixed identity plus a callback that
 * signs with that identity's own private key. This module never stores or
 * derives that private key itself; `sign` is entirely caller-owned.
 */
export interface WalletAppCardIdentity {
  /** Mutable pointer of the app's own app card. */
  cardPointer: string;
  /** ML-DSA-44 public key of the app's own app card, 1312 bytes raw. */
  publicKey: Uint8Array;
  /** Signs `message` with the app card's own private key. */
  sign: (message: Uint8Array) => Uint8Array | Promise<Uint8Array>;
}

export interface RegisterSubCardResult {
  registered: boolean;
}

/**
 * Callback shape for submitting a fully-signed `SubCardDocument` for
 * press registration. {@link createPressSubCardRegistrar} in
 * `pressSubmission.ts` is the real implementation; callers elsewhere (e.g.
 * Wallet SDK's own countersign/self-registration flows) accept this shape
 * as an injected dependency rather than talking to the press directly.
 */
export type RegisterSubCardFn = (doc: SignedSubCardDocument) => Promise<RegisterSubCardResult>;
