/**
 * Simulator platform module. The simulator emits the same document format as production, signed by a
 * test root, so this module reuses the production parser with a different root; it contains no format
 * logic of its own (G5). Verifiers accept it only when configured with `allowSimulator`.
 */
import type { AttestationVerifier } from "@membership-card-protocol/verifier/notary";
import { verifyAwsFormatEnvelope } from "./aws-nitro-enclaves.js";

export const simulator: AttestationVerifier = {
  platform: "simulator",
  verifyEnvelope: verifyAwsFormatEnvelope,
};
