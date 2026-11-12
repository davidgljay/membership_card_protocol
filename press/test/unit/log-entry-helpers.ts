// Re-exports from the verifier package, so the round-trip test reads entries
// exactly the way runtime verifiers do.
export { decryptCardHead } from '@membership-card-protocol/verifier';
import { deriveContentKey } from '../../src/functions/crypto.js';
export const hkdfSha3256Key = (pubkey: Uint8Array) => deriveContentKey(pubkey);
