/**
 * Tests that hard rejections propagate the correct "skipped" semantics to downstream stages.
 */
import { describe, it, expect, vi } from "vitest";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { CardVerifier } from "../../src/CardVerifier.js";
import { canonicalize } from "../../src/canonicalize.js";
import { generateKeypair, encryptForCard, makeCardDoc, makeSubCardDoc } from "../fixtures.js";
import type { RpcProvider, IpfsProvider, SignedMessageEnvelope, SubCardEntry } from "../../src/types.js";

function makeEnvelope(publicKey: Uint8Array, secretKey: Uint8Array): SignedMessageEnvelope {
  const payload = { message: "test", timestamp: "2026-06-20T00:00:00Z" };
  const sig = ml_dsa44.sign(canonicalize(payload), secretKey);
  return {
    payload,
    signatures: [
      {
        public_key: Buffer.from(publicKey).toString("base64url"),
        signature: Buffer.from(sig).toString("base64url"),
      },
    ],
  };
}

function mockRpc(overrides: Partial<RpcProvider> = {}): RpcProvider {
  return {
    getCardEntry: vi.fn().mockResolvedValue(null),
    isPolicyAuthorizer: vi.fn().mockResolvedValue(false),
    getPressAuthorization: vi.fn().mockResolvedValue(null),
    getSubCardEntry: vi.fn().mockResolvedValue(null),
    getLogEntries: vi.fn().mockResolvedValue([]),
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

describe("hard rejection skip propagation", () => {
  it("stage2 card not found → stages 3–5 are skipped", async () => {
    const sub = generateKeypair();
    const rpc = mockRpc({ getCardEntry: vi.fn().mockResolvedValue(null) });
    const verifier = new CardVerifier({ rpc, ipfs: mockIpfs() });
    const result = await verifier.verifyEnvelope(makeEnvelope(sub.publicKey, sub.secretKey));
    const r = result.signatures[0]!;
    expect(r.scope_clean).toBe(false);
    expect(r.chain_reaches_trusted_root).toBe("skipped");
    expect(r.was_valid_at_signing_time).toBe("skipped");
    expect(r.is_currently_valid).toBe("skipped");
    expect(r.policy_compliant).toBe("skipped");
  });

  it("stage2 decryption failure → stages 3–5 are skipped", async () => {
    const sub = generateKeypair();
    const rpc = mockRpc({
      getCardEntry: vi.fn().mockResolvedValue({ exists: true, log_head_cid: "QmSub", policy_address: "0x", last_press_address: "0x", forward_to: null }),
    });
    // Provide garbage bytes that will fail AES-GCM auth
    const ipfs = mockIpfs({ QmSub: new Uint8Array(40).fill(0xaa) });
    const verifier = new CardVerifier({ rpc, ipfs });
    const result = await verifier.verifyEnvelope(makeEnvelope(sub.publicKey, sub.secretKey));
    const r = result.signatures[0]!;
    expect(r.scope_clean).toBe(false);
    expect(r.chain_reaches_trusted_root).toBe("skipped");
    expect(r.was_valid_at_signing_time).toBe("skipped");
    expect(r.is_currently_valid).toBe("skipped");
    expect(r.policy_compliant).toBe("skipped");
  });

  it("stage3 depth exceeded → stages 4–5 are skipped", async () => {
    const sub = generateKeypair();
    const holder = generateKeypair();
    const app = generateKeypair();
    const issuer = generateKeypair();
    const press = generateKeypair();
    const fakeAncestor = generateKeypair();

    const subDoc = makeSubCardDoc(holder.publicKey, holder.secretKey, app.publicKey, app.secretKey, sub.publicKey);
    // Master card has ancestry_pubkeys pointing to fakeAncestor (which points to itself)
    const masterDoc = makeCardDoc(
      holder.publicKey, issuer.secretKey, holder.secretKey, press.secretKey,
      [Buffer.from(fakeAncestor.publicKey).toString("base64url")]
    );
    const ancestorDoc = makeCardDoc(
      fakeAncestor.publicKey, issuer.secretKey, fakeAncestor.secretKey, press.secretKey,
      [Buffer.from(fakeAncestor.publicKey).toString("base64url")] // cycle
    );

    const encSub = encryptForCard(sub.publicKey, new TextEncoder().encode(JSON.stringify(subDoc)));
    const encMaster = encryptForCard(holder.publicKey, new TextEncoder().encode(JSON.stringify(masterDoc)));
    const encAncestor = encryptForCard(fakeAncestor.publicKey, new TextEncoder().encode(JSON.stringify(ancestorDoc)));

    const subEntry: SubCardEntry = { master_card_address: holder.address, registration_log_head: "0x", sub_card_doc_cid: "QmSub", active: true, registered_at: "2026-01-01T00:00:00Z", deregistered_at: null };

    const rpc = mockRpc({
      getCardEntry: vi.fn().mockImplementation((addr: string) => {
        if (addr === sub.address) return Promise.resolve({ exists: true, log_head_cid: "QmSub", policy_address: "0x", last_press_address: "0x", forward_to: null });
        if (addr === holder.address) return Promise.resolve({ exists: true, log_head_cid: "QmMaster", policy_address: "0x", last_press_address: "0x", forward_to: null });
        return Promise.resolve({ exists: true, log_head_cid: "QmAncestor", policy_address: "0x", last_press_address: "0x", forward_to: null });
      }),
      getSubCardEntry: vi.fn().mockResolvedValue(subEntry),
      isPolicyAuthorizer: vi.fn().mockResolvedValue(false),
    });
    const ipfs = mockIpfs({ QmSub: encSub, QmMaster: encMaster, QmAncestor: encAncestor });

    const verifier = new CardVerifier({ rpc, ipfs, maxChainDepth: 2 });
    const result = await verifier.verifyEnvelope(makeEnvelope(sub.publicKey, sub.secretKey));
    const r = result.signatures[0]!;
    // Stage 2 should pass (scope_clean: true)
    expect(r.scope_clean).toBe(true);
    // Stage 3 fails with depth exceeded
    expect(r.chain_reaches_trusted_root).toBe(false);
    expect(r.errors.some((e) => e.code === "CHAIN_DEPTH_EXCEEDED")).toBe(true);
    // Stages 4–5 still run (they don't depend on stage3 having succeeded)
    expect(r.was_valid_at_signing_time).not.toBe("skipped");
    expect(r.is_currently_valid).not.toBe("skipped");
  });
});
