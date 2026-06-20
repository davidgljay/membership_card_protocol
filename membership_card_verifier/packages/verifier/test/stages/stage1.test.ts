import { describe, it, expect } from "vitest";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { canonicalize } from "../../src/canonicalize.js";
import { verifyStage1 } from "../../src/stages/stage1.js";
import { CardProtocolError } from "../../src/errors.js";
import type { SignatureEntry } from "../../src/types.js";

function makeValidEntry(payload: unknown): { entry: SignatureEntry; secretKey: Uint8Array } {
  const { secretKey, publicKey } = ml_dsa44.keygen();
  const canonical = canonicalize(payload);
  const sig = ml_dsa44.sign(canonical, secretKey);
  const entry: SignatureEntry = {
    public_key: Buffer.from(publicKey).toString("base64url"),
    signature: Buffer.from(sig).toString("base64url"),
  };
  return { entry, secretKey };
}

describe("stage1 — signature validity", () => {
  const payload = { message: "hello", timestamp: "2026-06-20T00:00:00Z" };

  it("valid signature returns signature_valid: true", () => {
    const { entry } = makeValidEntry(payload);
    const result = verifyStage1(entry, payload);
    expect(result.signature_valid).toBe(true);
    expect(result.public_key_bytes.length).toBe(1312);
  });

  it("invalid signature (wrong message) returns signature_valid: false without throwing", () => {
    const { entry } = makeValidEntry(payload);
    const result = verifyStage1(entry, { ...payload, message: "tampered" });
    expect(result.signature_valid).toBe(false);
  });

  it("wrong-length public key throws CardProtocolError INVALID_PUBLIC_KEY_LENGTH", () => {
    const shortKey = Buffer.alloc(32).toString("base64url");
    const { signature } = makeValidEntry(payload).entry;
    const entry: SignatureEntry = { public_key: shortKey, signature };
    expect(() => verifyStage1(entry, payload)).toThrow(CardProtocolError);
    let caught: unknown;
    try { verifyStage1(entry, payload); } catch (e) { caught = e; }
    expect((caught as CardProtocolError).code).toBe("INVALID_PUBLIC_KEY_LENGTH");
  });

  it("wrong-length signature throws CardProtocolError INVALID_SIGNATURE_LENGTH", () => {
    const { entry: validEntry } = makeValidEntry(payload);
    const shortSig = Buffer.alloc(16).toString("base64url");
    const entry: SignatureEntry = { public_key: validEntry.public_key, signature: shortSig };
    let caught: unknown;
    try { verifyStage1(entry, payload); } catch (e) { caught = e; }
    expect((caught as CardProtocolError).code).toBe("INVALID_SIGNATURE_LENGTH");
  });
});
