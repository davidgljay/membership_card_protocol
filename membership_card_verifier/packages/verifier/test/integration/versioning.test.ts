import { describe, it, expect, vi } from "vitest";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { CardVerifier } from "../../src/CardVerifier.js";
import { canonicalize } from "../../src/canonicalize.js";
import { generateKeypair } from "../fixtures.js";
import type { RpcProvider, IpfsProvider, SignedMessageEnvelope } from "../../src/types.js";

const DUMMY_APP_CERT_ROOT = "0x" + "a".repeat(64);

function mockRpc(overrides: Partial<RpcProvider> = {}): RpcProvider {
  return {
    getCardEntry: vi.fn().mockResolvedValue(null),
    isPolicyAuthorizer: vi.fn().mockResolvedValue(false),
    getPressAuthorization: vi.fn().mockResolvedValue(null),
    getSubCardEntry: vi.fn().mockResolvedValue(null),
    getCardEventLog: vi.fn().mockResolvedValue([]),
    getEasAnnotations: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function mockIpfs(): IpfsProvider {
  return { fetch: vi.fn().mockRejectedValue(new Error("not found")) };
}

function makeVerifier() {
  return new CardVerifier({ rpc: mockRpc(), ipfs: mockIpfs(), appCertificationRoot: DUMMY_APP_CERT_ROOT });
}

describe("version routing — verifyEnvelope", () => {
  it("proceeds through stages normally when protocol_version is '0.1'", async () => {
    const kp = generateKeypair();
    const payload: SignedMessageEnvelope["payload"] = {
      message: "test",
      protocol_version: "0.1",
      timestamp: "2026-06-20T00:00:00Z",
    };
    const envelope: SignedMessageEnvelope = {
      payload,
      signatures: [{
        public_key: Buffer.from(kp.publicKey).toString("base64url"),
        signature: Buffer.from(ml_dsa44.sign(canonicalize(payload), kp.secretKey)).toString("base64url"),
      }],
    };

    const result = await makeVerifier().verifyEnvelope(envelope);
    expect(result.protocol_version).toBe("0.1");
    expect(result.envelope_id).toMatch(/^[0-9a-f]{64}$/);
    expect(result.signatures).toHaveLength(1);
    expect(result.signatures[0]?.signature_valid).toBe(true);
  });

  it("returns MISSING_PROTOCOL_VERSION error without throwing when protocol_version is absent", async () => {
    const kp = generateKeypair();
    // Construct payload without protocol_version — cast to bypass TS enforcement
    const payload = { message: "test", timestamp: "2026-06-20T00:00:00Z" } as SignedMessageEnvelope["payload"];
    const envelope: SignedMessageEnvelope = {
      payload,
      signatures: [{
        public_key: Buffer.from(kp.publicKey).toString("base64url"),
        signature: Buffer.from(ml_dsa44.sign(canonicalize(payload), kp.secretKey)).toString("base64url"),
      }],
    };

    const result = await makeVerifier().verifyEnvelope(envelope);
    expect(result.protocol_version).toBe("unknown");
    const errors = result.signatures.flatMap((s) => s.errors);
    expect(errors.some((e) => e.code === "MISSING_PROTOCOL_VERSION")).toBe(true);
  });

  it("returns UNKNOWN_PROTOCOL_VERSION error without throwing when protocol_version is '99.0'", async () => {
    const kp = generateKeypair();
    const payload = { message: "test", protocol_version: "99.0", timestamp: "2026-06-20T00:00:00Z" } as SignedMessageEnvelope["payload"];
    const envelope: SignedMessageEnvelope = {
      payload,
      signatures: [{
        public_key: Buffer.from(kp.publicKey).toString("base64url"),
        signature: Buffer.from(ml_dsa44.sign(canonicalize(payload), kp.secretKey)).toString("base64url"),
      }],
    };

    const result = await makeVerifier().verifyEnvelope(envelope);
    expect(result.protocol_version).toBe("99.0");
    const errors = result.signatures.flatMap((s) => s.errors);
    expect(errors.some((e) => e.code === "UNKNOWN_PROTOCOL_VERSION")).toBe(true);
  });
});
