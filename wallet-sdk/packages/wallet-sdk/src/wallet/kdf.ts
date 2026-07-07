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
 *   App SDK's `hkdfSha3256`'s content-key derivation).
 * - Hash: SHA3-256, matching every other HKDF use in this codebase — one
 *   hash primitive for the whole SDK rather than introducing a second.
 *
 * This does not call App SDK's `hkdfSha3256` directly because that helper's
 * `info` parameter is a plain string used only for domain separation — it
 * has no `salt` parameter, and repurposing `info` to carry secret material
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
 * Derive a passkey's device-bound secret output from its WebAuthn PRF
 * extension output (App SDK's `PasskeyProvider`'s `prfOutput` field) — used
 * both for the device-bound passkey's `device_passkey_output` (Step 2.1,
 * `setupWallet.ts`/`recovery.ts`'s re-registration) and the synced-passkey
 * backup wrapping key (Step 2.4, `backupRegistration.ts`/`recovery.ts`).
 * Both are the exact same operation — a deterministic, credential-bound
 * secret, hashed with keccak256 purely for a fixed-length, domain-separated
 * output — so one function covers both call sites.
 *
 * CP-1 finding (superseded design, kept here as the historical record of
 * *why* this isn't derived from `attestationObject`, which an earlier
 * version of this function did): `attestationObject` is also the value
 * `setupWallet.ts` sends to the wallet service as `webauthn_public_key`
 * (needed there for future WebAuthn login verification, unrelated to this
 * KDF). Deriving a secret KDF input from a value the server also receives
 * meant the server alone — already holding `service_secret` — could
 * recompute `decryption_key` without the device ever being involved again,
 * collapsing the "neither factor alone suffices" security property this
 * whole module exists to provide. `prfOutput` has no such problem: it is
 * never transmitted anywhere by this SDK. It also solves the synced-passkey
 * recovery problem `attestationObject` couldn't: recovery can only
 * `assert()` against a synced credential, never `register()` it again, and
 * `attestationObject` is registration-ceremony-specific — not a reproducible
 * function of the credential alone — while the PRF extension yields the
 * same output from either ceremony, on any device sharing the credential.
 */
export function passkeyOutputFromPrf(prfOutput: Uint8Array): Uint8Array {
  // Uses the raw hash (not app-sdk's `keccak256`, which returns a hex
  // string) so the KDF receives raw bytes directly.
  return keccak_256(prfOutput);
}
