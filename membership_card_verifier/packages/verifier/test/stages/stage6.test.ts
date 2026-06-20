import { describe, it, expect, vi } from "vitest";
import { verifyStage6 } from "../../src/stages/stage6.js";
import type { RpcProvider, IpfsProvider, EasAttestation } from "../../src/types.js";

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

const CHAIN = ["0x" + "a".repeat(64)];

describe("stage6 — EAS annotation lookup", () => {
  it("fetchAnnotations: false returns empty without network calls", async () => {
    const rpc = mockRpc();
    const ipfs = mockIpfs();
    const result = await verifyStage6(CHAIN, rpc, ipfs, { fetchAnnotations: false });
    expect(result.annotations).toHaveLength(0);
    expect(rpc.getEasAnnotations).not.toHaveBeenCalled();
    expect(ipfs.fetch).not.toHaveBeenCalled();
  });

  it("recommended annotators endpoint fetch failure proceeds with empty list", async () => {
    // The endpoint is the placeholder string, so fetch will fail
    const rpc = mockRpc({ getEasAnnotations: vi.fn().mockResolvedValue([]) });
    const result = await verifyStage6(CHAIN, rpc, mockIpfs(), {
      fetchAnnotations: true,
      additionalAnnotators: [],
    });
    // Should still run (no error thrown), just empty annotations
    expect(result.annotations).toHaveLength(0);
    expect(result.errors.some((e) => e.code === "RECOMMENDED_ANNOTATORS_FETCH_FAILED")).toBe(true);
  });

  it("additional annotators are included even if recommended list fails", async () => {
    const annotatorAddr = "0x" + "b".repeat(64);
    const attestation: EasAttestation = {
      uid: "0x" + "c".repeat(64),
      attester: annotatorAddr,
      cid: "QmAnnotation",
      update_code: 400,
      effective_date: "2026-06-20T00:00:00Z",
    };
    const content = { note: "looks fine" };

    const rpc = mockRpc({
      getEasAnnotations: vi.fn().mockResolvedValue([attestation]),
      getCardEntry: vi.fn().mockResolvedValue({ exists: true, log_head_cid: "QmAnnotator", policy_address: "0x", last_press_address: "0x", forward_to: null }),
      isPolicyAuthorizer: vi.fn().mockResolvedValue(false),
    });
    const ipfs = mockIpfs({
      QmAnnotation: new TextEncoder().encode(JSON.stringify(content)),
    });

    const result = await verifyStage6(CHAIN, rpc, ipfs, {
      fetchAnnotations: true,
      additionalAnnotators: [annotatorAddr],
    });

    expect(result.annotations).toHaveLength(1);
    expect(result.annotations[0]?.eas_uid).toBe(attestation.uid);
    expect(result.annotations[0]?.is_recommended_annotator).toBe(false);
  });

  it("annotation IPFS fetch failure omits annotation and records error", async () => {
    const annotatorAddr = "0x" + "b".repeat(64);
    const attestation: EasAttestation = {
      uid: "0x" + "c".repeat(64),
      attester: annotatorAddr,
      cid: "QmMissing",
      update_code: 400,
      effective_date: "2026-06-20T00:00:00Z",
    };

    const rpc = mockRpc({
      getEasAnnotations: vi.fn().mockResolvedValue([attestation]),
    });
    const result = await verifyStage6(CHAIN, rpc, mockIpfs(), {
      fetchAnnotations: true,
      additionalAnnotators: [annotatorAddr],
    });

    expect(result.annotations).toHaveLength(0);
    expect(result.errors.some((e) => e.code === "ANNOTATION_FETCH_FAILED")).toBe(true);
  });
});
