/**
 * Wallet notary configuration (wallet_sdk.md §7b.1).
 */
export interface NotaryConfig {
  attestationRoots: { "aws-nitro-enclaves": Uint8Array; simulator?: Uint8Array };
  /** Hard-coded `false` in production builds. */
  allowSimulator: boolean;
  /** List card addresses (protocol-objects.md §34); both lists must pass algorithm L before use. */
  acceptedRuntimesCard: string;
  programAllowlistCard: string;
  /** NotaryCardPolicy CID. */
  notaryCardPolicy: string;
  acceptedKems: ["x-wing-draft-06"];
  /** Default 86400. */
  maxAttestationAgeSeconds?: number;
}

export const DEFAULT_MAX_ATTESTATION_AGE_SECONDS = 86_400;
