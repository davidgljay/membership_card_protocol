import { describe, it, expect, vi } from "vitest";
import { verifyStage5 } from "../../src/stages/stage5.js";
import type { RpcProvider, IpfsProvider, CardDocument, CardEntry, PressAuthEntry } from "../../src/types.js";

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

const CARD_ADDRESS = "0x" + "a".repeat(64);
const CARD_CID = "QmCard";
const RAW_BYTES = new TextEncoder().encode("{}");

const BASE_CARD_DOC: CardDocument = {
  policy_id: "QmPolicy",
  issuer_card: "0x" + "b".repeat(64),
  press_card: "0x" + "c".repeat(64),
  recipient_pubkey: "AAEC",
  issued_at: "2026-06-20T00:00:00Z",
  ancestry_pubkeys: [],
  issuer_signature: "sig1",
  holder_signature: "sig2",
  press_signature: "sig3",
};

const BASE_CARD_ENTRY: CardEntry = {
  log_head_cid: CARD_CID,
  policy_address: "0x" + "d".repeat(64),
  last_press_address: "0x" + "e".repeat(64),
  forward_to: null,
  exists: true,
};

const ACTIVE_PRESS: PressAuthEntry = {
  press_public_key: "pub",
  mldsa44_key_hash: "hash",
  active: true,
  authorized_at: "2026-01-01T00:00:00Z",
  revoked_at: null,
};

describe("stage5 — policy compliance", () => {
  it("compliant card with valid press auth returns policy_compliant: true", async () => {
    const policyDoc = { field_definitions: {} };
    const rpc = mockRpc({
      getPressAuthorization: vi.fn().mockResolvedValue(ACTIVE_PRESS),
    });
    const ipfs = mockIpfs({
      QmPolicy: new TextEncoder().encode(JSON.stringify(policyDoc)),
    });
    const result = await verifyStage5(BASE_CARD_DOC, BASE_CARD_ENTRY, CARD_ADDRESS, CARD_CID, RAW_BYTES, rpc, ipfs, {});
    expect(result.policy_compliant).toBe(true);
    expect(result.press_subsequently_revoked).toBe(false);
  });

  it("missing required field → policy_compliant: false", async () => {
    const policyDoc = { field_definitions: { required_field: { required: true } } };
    const rpc = mockRpc({
      getPressAuthorization: vi.fn().mockResolvedValue(ACTIVE_PRESS),
    });
    const ipfs = mockIpfs({
      QmPolicy: new TextEncoder().encode(JSON.stringify(policyDoc)),
    });
    const result = await verifyStage5(BASE_CARD_DOC, BASE_CARD_ENTRY, CARD_ADDRESS, CARD_CID, RAW_BYTES, rpc, ipfs, {});
    expect(result.policy_compliant).toBe(false);
    expect(result.non_compliance_reported).toBe(false); // endpoint is placeholder → report fails
  });

  it("no press authorization entry → policy_compliant: false", async () => {
    const policyDoc = { field_definitions: {} };
    const rpc = mockRpc({
      getPressAuthorization: vi.fn().mockResolvedValue(null),
    });
    const ipfs = mockIpfs({
      QmPolicy: new TextEncoder().encode(JSON.stringify(policyDoc)),
    });
    const result = await verifyStage5(BASE_CARD_DOC, BASE_CARD_ENTRY, CARD_ADDRESS, CARD_CID, RAW_BYTES, rpc, ipfs, {});
    expect(result.policy_compliant).toBe(false);
  });

  it("press subsequently revoked → policy_compliant: true, press_subsequently_revoked: true", async () => {
    const policyDoc = { field_definitions: {} };
    const rpc = mockRpc({
      getPressAuthorization: vi.fn().mockResolvedValue({ ...ACTIVE_PRESS, active: false, revoked_at: "2026-06-10T00:00:00Z" }),
    });
    const ipfs = mockIpfs({
      QmPolicy: new TextEncoder().encode(JSON.stringify(policyDoc)),
    });
    const result = await verifyStage5(BASE_CARD_DOC, BASE_CARD_ENTRY, CARD_ADDRESS, CARD_CID, RAW_BYTES, rpc, ipfs, {});
    expect(result.policy_compliant).toBe(true);
    expect(result.press_subsequently_revoked).toBe(true);
  });

  it("non-compliance POST failure still returns a result", async () => {
    const policyDoc = { field_definitions: {} };
    const rpc = mockRpc({ getPressAuthorization: vi.fn().mockResolvedValue(null) });
    const ipfs = mockIpfs({ QmPolicy: new TextEncoder().encode(JSON.stringify(policyDoc)) });
    // The endpoint is the placeholder string — fetch will fail, but result is still returned
    const result = await verifyStage5(BASE_CARD_DOC, BASE_CARD_ENTRY, CARD_ADDRESS, CARD_CID, RAW_BYTES, rpc, ipfs, {});
    expect(result.policy_compliant).toBe(false);
    expect(result.non_compliance_reported).toBe(false);
    expect(result.errors.some((e) => e.code === "NON_COMPLIANCE_REPORT_FAILED")).toBe(true);
  });
});
