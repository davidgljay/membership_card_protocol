import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { canonicalize, decryptRoutingEnvelope, mlKem768GenerateKeypair } from "@membership-card-protocol/app-sdk";
import { b64uDecode } from "@membership-card-protocol/verifier/notary";

const load = (n: string) => JSON.parse(readFileSync(new URL(`../../vectors/messaging/${n}`, import.meta.url), "utf8"));

describe("notary_output messages: notary-messaging (Rust) and the App SDK (messaging_protocol.md §24)", () => {
  it("the App SDK opens a message sealed by Rust, and the K_id signature over the canonical payload verifies", () => {
    const v = load("rust_blob.json");
    const kp = mlKem768GenerateKeypair(b64uDecode(v.kem_seed, 64));
    const envelope = decryptRoutingEnvelope(v.routing, kp.secretKey);
    expect(envelope).toEqual(v.envelope);
    const sig = envelope.signatures[0]!;
    expect(sig.public_key).toBe(v.k_id_public_key);
    expect(ml_dsa44.verify(b64uDecode(sig.signature, 2420), canonicalize(envelope.payload), b64uDecode(sig.public_key, 1312))).toBe(true);
    expect((envelope.payload as { type: string }).type).toBe("notary_output");
  });
  it("another sub-card's key can't open it", () => {
    const v = load("rust_blob.json");
    const other = mlKem768GenerateKeypair(Uint8Array.from({ length: 64 }, (_, i) => (i * 11 + 5) & 0xff));
    expect(() => decryptRoutingEnvelope(v.routing, other.secretKey)).toThrow();
  });
  it("Rust derives the same ML-KEM public key from the seed as the App SDK (the static TypeScript vector)", () => {
    const v = load("ts_blob.json");
    expect(mlKem768GenerateKeypair(b64uDecode(v.kem_seed, 64)).publicKey).toEqual(b64uDecode(v.kem_public_key, 1184));
  });
});
