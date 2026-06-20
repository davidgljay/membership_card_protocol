import { canonicalize } from "../canonicalize.js";
import { mlDsa44Verify } from "../crypto.js";
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
  const publicKeyBytes = Buffer.from(entry.public_key, "base64url");
  if (publicKeyBytes.length !== 1312) {
    throw new CardProtocolError(
      "INVALID_PUBLIC_KEY_LENGTH",
      `public_key must be 1312 bytes after base64url decode, got ${publicKeyBytes.length}`
    );
  }

  const signatureBytes = Buffer.from(entry.signature, "base64url");
  if (signatureBytes.length !== 2420) {
    throw new CardProtocolError(
      "INVALID_SIGNATURE_LENGTH",
      `signature must be 2420 bytes after base64url decode, got ${signatureBytes.length}`
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
