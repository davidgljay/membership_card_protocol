import { canonicalize } from "../canonicalize.js";
import { mlDsa44Verify, secp256r1Phase1Verify, base64UrlToBytes } from "../crypto.js";
import { CardProtocolError } from "../errors.js";
import type { SignatureEntry } from "../types.js";

export interface Stage1Result {
  signature_valid: boolean;
  public_key_bytes: Uint8Array;
}

export function verifyStage1(
  entry: SignatureEntry,
  payload: unknown
): Stage1Result {
  const scheme = entry.key_scheme ?? "mldsa44";

  if (scheme === "secp256r1_phase1") {
    return verifyStage1Secp256r1Phase1(entry, payload);
  }

  // Default: ML-DSA-44 (Phase 2 / production key scheme)
  return verifyStage1MlDsa44(entry, payload);
}

function verifyStage1MlDsa44(entry: SignatureEntry, payload: unknown): Stage1Result {
  const publicKeyBytes = base64UrlToBytes(entry.public_key);
  if (publicKeyBytes.length !== 1312) {
    throw new CardProtocolError(
      "INVALID_PUBLIC_KEY_LENGTH",
      `mldsa44 public_key must be 1312 bytes after base64url decode, got ${publicKeyBytes.length}`
    );
  }

  const signatureBytes = base64UrlToBytes(entry.signature);
  if (signatureBytes.length !== 2420) {
    throw new CardProtocolError(
      "INVALID_SIGNATURE_LENGTH",
      `mldsa44 signature must be 2420 bytes after base64url decode, got ${signatureBytes.length}`
    );
  }

  const canonicalPayload = canonicalize(payload);
  const valid = mlDsa44Verify(
    new Uint8Array(publicKeyBytes),
    canonicalPayload,
    new Uint8Array(signatureBytes)
  );

  return { signature_valid: valid, public_key_bytes: new Uint8Array(publicKeyBytes) };
}

function verifyStage1Secp256r1Phase1(entry: SignatureEntry, payload: unknown): Stage1Result {
  const publicKeyBytes = base64UrlToBytes(entry.public_key);
  if (publicKeyBytes.length !== 64) {
    throw new CardProtocolError(
      "INVALID_PUBLIC_KEY_LENGTH",
      `secp256r1_phase1 public_key must be 64 bytes (x||y) after base64url decode, got ${publicKeyBytes.length}`
    );
  }

  const signatureBytes = base64UrlToBytes(entry.signature);
  if (signatureBytes.length !== 64) {
    throw new CardProtocolError(
      "INVALID_SIGNATURE_LENGTH",
      `secp256r1_phase1 signature must be 64 bytes (r||s) after base64url decode, got ${signatureBytes.length}`
    );
  }

  const canonicalPayload = canonicalize(payload);
  const valid = secp256r1Phase1Verify(
    new Uint8Array(publicKeyBytes),
    canonicalPayload,
    new Uint8Array(signatureBytes)
  );

  return { signature_valid: valid, public_key_bytes: new Uint8Array(publicKeyBytes) };
}
