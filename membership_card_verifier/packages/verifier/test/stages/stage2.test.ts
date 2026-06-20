import { describe, it, expect, vi } from "vitest";
import { verifyStage2 } from "../../src/stages/stage2.js";
import { generateKeypair, encryptForCard, makeCardDoc, makeSubCardDoc } from "../fixtures.js";
import type { RpcProvider, IpfsProvider, SubCardEntry } from "../../src/types.js";

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

describe("stage2 — sub-card to master link", () => {
  it("card not found returns scope_clean: false", async () => {
    const sub = generateKeypair();
    const rpc = mockRpc({ getCardEntry: vi.fn().mockResolvedValue(null) });
    const ipfs = mockIpfs();
    const result = await verifyStage2(sub.publicKey, rpc, ipfs);
    expect(result.scope_clean).toBe(false);
    expect(result.errors[0]?.code).toBe("CARD_NOT_FOUND");
  });

  it("decryption failure returns scope_clean: false", async () => {
    const sub = generateKeypair();
    const rpc = mockRpc({
      getCardEntry: vi.fn().mockResolvedValue({ exists: true, log_head_cid: "QmSub", policy_address: "0x", last_press_address: "0x", forward_to: null }),
    });
    const ipfs = mockIpfs({ QmSub: new Uint8Array(40).fill(0xaa) }); // garbage bytes
    const result = await verifyStage2(sub.publicKey, rpc, ipfs);
    expect(result.scope_clean).toBe(false);
    expect(result.errors[0]?.code).toBe("DECRYPTION_FAILED");
  });

  it("address binding mismatch returns scope_clean: false", async () => {
    const sub = generateKeypair();
    const holder = generateKeypair();
    const app = generateKeypair();
    // Build a sub-card doc where holder_primary_card is wrong
    const subDocCorrupt = makeSubCardDoc(holder.publicKey, holder.secretKey, app.publicKey, app.secretKey, sub.publicKey);
    subDocCorrupt.holder_primary_card = "0000000000000000000000000000000000000000000000000000000000000001"; // wrong

    const encrypted = encryptForCard(sub.publicKey, new TextEncoder().encode(JSON.stringify(subDocCorrupt)));
    const rpc = mockRpc({
      getCardEntry: vi.fn().mockResolvedValue({ exists: true, log_head_cid: "QmSub", policy_address: "0x", last_press_address: "0x", forward_to: null }),
    });
    const ipfs = mockIpfs({ QmSub: encrypted });
    const result = await verifyStage2(sub.publicKey, rpc, ipfs);
    expect(result.scope_clean).toBe(false);
    expect(result.errors[0]?.code).toBe("ADDRESS_BINDING_MISMATCH");
  });

  it("sub-card not in master's registry returns scope_clean: false", async () => {
    const sub = generateKeypair();
    const holder = generateKeypair();
    const app = generateKeypair();
    const issuer = generateKeypair();
    const press = generateKeypair();

    const subDoc = makeSubCardDoc(holder.publicKey, holder.secretKey, app.publicKey, app.secretKey, sub.publicKey);
    const masterDoc = makeCardDoc(holder.publicKey, issuer.secretKey, holder.secretKey, press.secretKey);

    const encSubDoc = encryptForCard(sub.publicKey, new TextEncoder().encode(JSON.stringify(subDoc)));
    const encMasterDoc = encryptForCard(holder.publicKey, new TextEncoder().encode(JSON.stringify(masterDoc)));

    const rpc = mockRpc({
      getCardEntry: vi.fn().mockImplementation((addr: string) => {
        if (addr === sub.address) return Promise.resolve({ exists: true, log_head_cid: "QmSub", policy_address: "0x", last_press_address: "0x", forward_to: null });
        if (addr === holder.address) return Promise.resolve({ exists: true, log_head_cid: "QmMaster", policy_address: "0x", last_press_address: "0x", forward_to: null });
        return Promise.resolve(null);
      }),
      // Sub-card entry links to a DIFFERENT master card (mismatch)
      getSubCardEntry: vi.fn().mockResolvedValue({ master_card_address: "0xdifferent", registration_log_head: "0x", sub_card_doc_cid: "QmSub", active: true, registered_at: "2026-01-01T00:00:00Z", deregistered_at: null } as SubCardEntry),
    });
    const ipfs = mockIpfs({ QmSub: encSubDoc, QmMaster: encMasterDoc });
    const result = await verifyStage2(sub.publicKey, rpc, ipfs);
    expect(result.scope_clean).toBe(false);
    expect(result.errors[0]?.code).toBe("ADDRESS_BINDING_MISMATCH");
  });

  it("inactive sub-card returns scope_clean: false", async () => {
    const sub = generateKeypair();
    const holder = generateKeypair();
    const app = generateKeypair();
    const issuer = generateKeypair();
    const press = generateKeypair();

    const subDoc = makeSubCardDoc(holder.publicKey, holder.secretKey, app.publicKey, app.secretKey, sub.publicKey);
    const masterDoc = makeCardDoc(holder.publicKey, issuer.secretKey, holder.secretKey, press.secretKey);

    const encSubDoc = encryptForCard(sub.publicKey, new TextEncoder().encode(JSON.stringify(subDoc)));
    const encMasterDoc = encryptForCard(holder.publicKey, new TextEncoder().encode(JSON.stringify(masterDoc)));

    const rpc = mockRpc({
      getCardEntry: vi.fn().mockImplementation((addr: string) => {
        if (addr === sub.address) return Promise.resolve({ exists: true, log_head_cid: "QmSub", policy_address: "0x", last_press_address: "0x", forward_to: null });
        if (addr === holder.address) return Promise.resolve({ exists: true, log_head_cid: "QmMaster", policy_address: "0x", last_press_address: "0x", forward_to: null });
        return Promise.resolve(null);
      }),
      getSubCardEntry: vi.fn().mockResolvedValue({ master_card_address: holder.address, registration_log_head: "0x", sub_card_doc_cid: "QmSub", active: false, registered_at: "2026-01-01T00:00:00Z", deregistered_at: "2026-06-01T00:00:00Z" } as SubCardEntry),
    });
    const ipfs = mockIpfs({ QmSub: encSubDoc, QmMaster: encMasterDoc });
    const result = await verifyStage2(sub.publicKey, rpc, ipfs);
    expect(result.scope_clean).toBe(false);
    expect(result.errors.some((e) => e.code === "SUB_CARD_INACTIVE")).toBe(true);
  });

  it("happy path returns scope_clean: true with master_card_doc", async () => {
    const sub = generateKeypair();
    const holder = generateKeypair();
    const app = generateKeypair();
    const issuer = generateKeypair();
    const press = generateKeypair();

    const subDoc = makeSubCardDoc(holder.publicKey, holder.secretKey, app.publicKey, app.secretKey, sub.publicKey);
    const masterDoc = makeCardDoc(holder.publicKey, issuer.secretKey, holder.secretKey, press.secretKey);

    const encSubDoc = encryptForCard(sub.publicKey, new TextEncoder().encode(JSON.stringify(subDoc)));
    const encMasterDoc = encryptForCard(holder.publicKey, new TextEncoder().encode(JSON.stringify(masterDoc)));

    const rpc = mockRpc({
      getCardEntry: vi.fn().mockImplementation((addr: string) => {
        if (addr === sub.address) return Promise.resolve({ exists: true, log_head_cid: "QmSub", policy_address: "0x", last_press_address: "0x", forward_to: null });
        if (addr === holder.address) return Promise.resolve({ exists: true, log_head_cid: "QmMaster", policy_address: "0x", last_press_address: "0x", forward_to: null });
        return Promise.resolve(null);
      }),
      getSubCardEntry: vi.fn().mockResolvedValue({ master_card_address: holder.address, registration_log_head: "0x", sub_card_doc_cid: "QmSub", active: true, registered_at: "2026-01-01T00:00:00Z", deregistered_at: null } as SubCardEntry),
    });
    const ipfs = mockIpfs({ QmSub: encSubDoc, QmMaster: encMasterDoc });
    const result = await verifyStage2(sub.publicKey, rpc, ipfs);
    expect(result.scope_clean).toBe(true);
    expect(result.master_card_doc).toBeDefined();
  });
});
