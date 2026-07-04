import { keccak_256, sha3_256 } from '@noble/hashes/sha3';
import { hkdf } from '@noble/hashes/hkdf';

/**
 * `decryption_key = KDF(device_passkey_output, service_secret)`
 * (`wallet_backup_and_recovery.md §Process 1` Step 4).
 *
 * Construction (judgment call — the spec states the two inputs but not the
 * exact HKDF slot each occupies; see `plans/client-sdk/strategic-plan.md`'s
 * call-out that this computation is security-critical and must be gotten
 * "exactly right, not approximately right"):
 *
 * - `ikm` (input keying material) = `device_passkey_output`. It's the value
 *   that's actually device/credential-bound and produced first, in Step 2 —
 *   the natural "the key material this is derived from" slot.
 * - `salt` = `service_secret`. HKDF's extract step folds `ikm` and `salt`
 *   together via HMAC (`PRK = HMAC-Hash(salt, ikm)`) — this is the standard
 *   two-secret-input HKDF shape, and is the only way both inputs materially
 *   affect the output through a single HKDF call (an `info` slot is only
 *   domain-separation context, not secret keying material, so putting
 *   `service_secret` there would not satisfy the spec's explicit property
 *   that "neither `device_passkey_output` alone nor `service_secret` alone
 *   can reconstruct `decryption_key`" as strongly — salt is mixed via HMAC,
 *   giving both values equal cryptographic weight).
 * - `info` = a fixed domain-separation label, so this derivation can never
 *   collide with any other HKDF-SHA3-256 use elsewhere in the SDK (e.g.
 *   `hkdfSha3256`'s content-key derivation, `crypto/hashes.ts`).
 * - Hash: SHA3-256, matching every other HKDF use in this codebase
 *   (`crypto/hashes.ts`'s `hkdfSha3256`) — one hash primitive for the whole
 *   SDK rather than introducing a second.
 *
 * This does not call `hkdfSha3256` directly because that helper's `info`
 * parameter is a plain string used only for domain separation — it has no
 * `salt` parameter, and repurposing `info` to carry secret material
 * (`service_secret`) would be a weaker construction than folding it in via
 * HKDF's dedicated `salt` input. This function calls the underlying
 * `@noble/hashes/hkdf` primitive directly with the same hash function for
 * that reason.
 */
const DECRYPTION_KEY_INFO = new TextEncoder().encode('card-protocol-wallet-decryption-key-v1');
const DECRYPTION_KEY_LENGTH = 32;

export function deriveDecryptionKey(
  devicePasskeyOutput: Uint8Array,
  serviceSecret: Uint8Array
): Uint8Array {
  return hkdf(sha3_256, devicePasskeyOutput, serviceSecret, DECRYPTION_KEY_INFO, DECRYPTION_KEY_LENGTH);
}

/**
 * Derive `device_passkey_output` from a `PasskeyProvider.register()` result.
 *
 * Judgment call: the `PasskeyProvider` interface (Step 1.2) exposes no
 * WebAuthn PRF-extension output or other explicit secret derived from the
 * authenticator — `register()` returns only `credentialId`,
 * `attestationObject`, and `clientDataJSON` (see
 * `providers/PasskeyProvider.ts`), and the spec's Step 2 creates the
 * device-bound passkey without a subsequent `assert()` call before Step 4's
 * KDF. Of the fields available at registration, `attestationObject` is the
 * one that is both device-bound (produced by this device's authenticator,
 * not just echoed input) and unique per credential (it embeds the
 * authenticator's attestation over the newly generated credential public
 * key) — `clientDataJSON` is mostly caller-supplied/echoed data (the
 * challenge, origin) and `credentialId` alone is a public identifier, not
 * secret material. Hashing `attestationObject` with keccak256 (the SDK's
 * existing general-purpose hash, per `crypto/hashes.ts`) yields a
 * fixed-length, device/credential-bound value to feed into the KDF as
 * `device_passkey_output`.
 */
export function devicePasskeyOutputFromRegistration(attestationObject: Uint8Array): Uint8Array {
  // Uses the raw hash (not `keccak256` from `crypto/hashes.ts`, which
  // returns a hex string) so the KDF receives raw bytes directly.
  return keccak_256(attestationObject);
}

/**
 * Derive the synced-passkey backup wrapping key from a WebAuthn PRF
 * extension output (Step 2.4, `wallet/backupRegistration.ts` /
 * `wallet/recovery.ts`).
 *
 * Judgment call: unlike the device-bound passkey above,
 * `synced_passkey_output` must be re-derivable on a *different* device
 * during recovery, where only `PasskeyProvider.assert()` (never
 * `register()`) is available for a synced credential —
 * `devicePasskeyOutputFromRegistration`'s `attestationObject` hash cannot
 * satisfy this, since `attestationObject` is produced once, at registration,
 * and is not a reproducible function of the credential alone. The WebAuthn
 * PRF extension is designed exactly for this case: it returns a
 * deterministic, credential-bound secret from both `register()` and
 * `assert()` for the same credential (see `providers/PasskeyProvider.ts`'s
 * `prfOutput` field). Hashed with keccak256 here purely for a fixed-length,
 * domain-separated output, matching this file's other derivation.
 */
export function syncedPasskeyOutputFromPrf(prfOutput: Uint8Array): Uint8Array {
  return keccak_256(prfOutput);
}
