import { describe, it, expect, vi } from "vitest";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { CardVerifier } from "../../src/CardVerifier.js";
import { CardProtocolError } from "../../src/errors.js";
import { canonicalize } from "../../src/canonicalize.js";
import { generateKeypair, encryptForCard, makeCardDoc, makeSubCardDoc } from "../fixtures.js";
import type { RpcProvider, IpfsProvider, SignedMessageEnvelope, SubCardEntry } from "../../src/types.js";

const DUMMY_APP_CERT_ROOT = "0x" + "e".repeat(64);

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

function mockIpfs(responses: Record<string, Uint8Array> = {}): IpfsProvider {
  return {
    fetch: vi.fn().mockImplementation((cid: string) => {
      if (cid in responses) return Promise.resolve(responses[cid]);
      return Promise.reject(new Error(`CID not found: ${cid}`));
    }),
  };
}

describe("CardVerifier", () => {
  it("constructor rejects missing rpc", () => {
    expect(
      () => new CardVerifier({ rpc: undefined as never, ipfs: mockIpfs(), appCertificationRoot: DUMMY_APP_CERT_ROOT })
    ).toThrow(CardProtocolError);
  });

  it("constructor rejects missing ipfs", () => {
    expect(
      () => new CardVerifier({ rpc: mockRpc(), ipfs: undefined as never, appCertificationRoot: DUMMY_APP_CERT_ROOT })
    ).toThrow(CardProtocolError);
  });

  it("verifyEnvelope returns deterministic envelope_id", async () => {
    const sub = generateKeypair();
    const payload = { message: "hello", protocol_version: "0.1", timestamp: "2026-06-20T00:00:00Z" };
    const envelope: SignedMessageEnvelope = {
      payload,
      signatures: [
        {
          public_key: Buffer.from(sub.publicKey).toString("base64url"),
          signature: Buffer.from(ml_dsa44.sign(canonicalize(payload), sub.secretKey)).toString("base64url"),
        },
      ],
    };

    const rpc = mockRpc({
      getCardEntry: vi.fn().mockResolvedValue(null), // card not found → scope_clean: false
    });
    const verifier = new CardVerifier({ rpc, ipfs: mockIpfs(), appCertificationRoot: DUMMY_APP_CERT_ROOT });

    const r1 = await verifier.verifyEnvelope(envelope);
    const r2 = await verifier.verifyEnvelope(envelope);
    expect(r1.envelope_id).toBe(r2.envelope_id);
    expect(r1.envelope_id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifyEnvelope returns one result per signature entry", async () => {
    const sub1 = generateKeypair();
    const sub2 = generateKeypair();
    const payload = { message: "multi-sig", protocol_version: "0.1", timestamp: "2026-06-20T00:00:00Z" };
    const canonical = canonicalize(payload);
    const envelope: SignedMessageEnvelope = {
      payload,
      signatures: [
        {
          public_key: Buffer.from(sub1.publicKey).toString("base64url"),
          signature: Buffer.from(ml_dsa44.sign(canonical, sub1.secretKey)).toString("base64url"),
        },
        {
          public_key: Buffer.from(sub2.publicKey).toString("base64url"),
          signature: Buffer.from(ml_dsa44.sign(canonical, sub2.secretKey)).toString("base64url"),
        },
      ],
    };

    const rpc = mockRpc({ getCardEntry: vi.fn().mockResolvedValue(null) });
    const verifier = new CardVerifier({ rpc, ipfs: mockIpfs(), appCertificationRoot: DUMMY_APP_CERT_ROOT });
    const result = await verifier.verifyEnvelope(envelope);
    expect(result.signatures).toHaveLength(2);
    expect(result.signatures[0]?.signature_valid).toBe(true);
    expect(result.signatures[1]?.signature_valid).toBe(true);
  });

  it("verifyCard with known trusted root returns chain_reaches_trusted_root: true", async () => {
    const card = generateKeypair();
    const rpc = mockRpc({
      getCardEntry: vi.fn().mockResolvedValue({ exists: true, log_head_cid: "QmCard", policy_address: "0x", last_press_address: "0x", forward_to: null }),
      isPolicyAuthorizer: vi.fn().mockResolvedValue(true),
      getCardEventLog: vi.fn().mockResolvedValue([]),
    });
    const verifier = new CardVerifier({ rpc, ipfs: mockIpfs(), appCertificationRoot: DUMMY_APP_CERT_ROOT });
    const result = await verifier.verifyCard(card.address);
    expect(result.signature_valid).toBeNull();
    expect(result.chain_reaches_trusted_root).toBe(true);
    expect(result.scope_clean).toBe("skipped");
  });

  it("verifier constructed without appCertificationRoot verifies a primary-card (verifyCard) with no error", async () => {
    // Confirms the friction is actually removed: a verifier scoped to primary-card
    // checks only (no sub-card path ever triggered) never needs appCertificationRoot.
    const card = generateKeypair();
    const rpc = mockRpc({
      getCardEntry: vi.fn().mockResolvedValue({ exists: true, log_head_cid: "QmCard", policy_address: "0x", last_press_address: "0x", forward_to: null }),
      isPolicyAuthorizer: vi.fn().mockResolvedValue(true),
      getCardEventLog: vi.fn().mockResolvedValue([]),
    });
    const verifier = new CardVerifier({ rpc, ipfs: mockIpfs() }); // no appCertificationRoot
    const result = await verifier.verifyCard(card.address);
    expect(result.signature_valid).toBeNull();
    expect(result.chain_reaches_trusted_root).toBe(true);
    expect(result.scope_clean).toBe("skipped");
    expect(result.errors).toHaveLength(0);
  });

  it("stage2 hard rejection propagates skipped to stages 3–5", async () => {
    const sub = generateKeypair();
    const payload = { message: "test", protocol_version: "0.1", timestamp: "2026-06-20T00:00:00Z" };
    const canonical = canonicalize(payload);
    const envelope: SignedMessageEnvelope = {
      payload,
      signatures: [
        {
          public_key: Buffer.from(sub.publicKey).toString("base64url"),
          signature: Buffer.from(ml_dsa44.sign(canonical, sub.secretKey)).toString("base64url"),
        },
      ],
    };

    // Card not found → hard rejection at stage 2
    const rpc = mockRpc({ getCardEntry: vi.fn().mockResolvedValue(null) });
    const verifier = new CardVerifier({ rpc, ipfs: mockIpfs(), appCertificationRoot: DUMMY_APP_CERT_ROOT });
    const result = await verifier.verifyEnvelope(envelope);
    const sig = result.signatures[0]!;
    expect(sig.scope_clean).toBe(false);
    expect(sig.chain_reaches_trusted_root).toBe("skipped");
    expect(sig.was_valid_at_signing_time).toBe("skipped");
    expect(sig.is_currently_valid).toBe("skipped");
    expect(sig.policy_compliant).toBe("skipped");
  });
});
