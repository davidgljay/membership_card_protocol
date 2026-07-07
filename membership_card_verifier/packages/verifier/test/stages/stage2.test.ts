import { describe, it, expect, vi } from "vitest";
import { verifyStage2 } from "../../src/stages/stage2.js";
import { CardVerifier } from "../../src/CardVerifier.js";
import { CardProtocolError } from "../../src/errors.js";
import { generateKeypair, encryptForCard, makeCardDoc, makeSubCardDoc } from "../fixtures.js";
import type { RpcProvider, IpfsProvider, SubCardEntry } from "../../src/types.js";

const DUMMY_CERT_ROOT = "0x" + "f".repeat(64);

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
    const result = await verifyStage2(sub.publicKey, rpc, ipfs, { appCertificationRoot: DUMMY_CERT_ROOT });
    expect(result.scope_clean).toBe(false);
    expect(result.errors[0]?.code).toBe("CARD_NOT_FOUND");
  });

  it("decryption failure returns scope_clean: false", async () => {
    const sub = generateKeypair();
    const rpc = mockRpc({
      getCardEntry: vi.fn().mockResolvedValue({ exists: true, log_head_cid: "QmSub", policy_address: "0x", last_press_address: "0x", forward_to: null }),
    });
    const ipfs = mockIpfs({ QmSub: new Uint8Array(40).fill(0xaa) }); // garbage bytes
    const result = await verifyStage2(sub.publicKey, rpc, ipfs, { appCertificationRoot: DUMMY_CERT_ROOT });
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
    const result = await verifyStage2(sub.publicKey, rpc, ipfs, { appCertificationRoot: DUMMY_CERT_ROOT });
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
    // Add sub-card to active_subcards so it passes Step 9, but fails on-chain binding at Step 10
    masterDoc.active_subcards = [Buffer.from(sub.publicKey).toString("base64url")];

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
    const result = await verifyStage2(sub.publicKey, rpc, ipfs, { appCertificationRoot: DUMMY_CERT_ROOT });
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
    // Add sub-card's public key to active_subcards so it passes Step 9
    masterDoc.active_subcards = [Buffer.from(sub.publicKey).toString("base64url")];

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
    const result = await verifyStage2(sub.publicKey, rpc, ipfs, { appCertificationRoot: DUMMY_CERT_ROOT });
    expect(result.scope_clean).toBe(false);
    expect(result.errors.some((e) => e.code === "SUB_CARD_INACTIVE")).toBe(true);
  });

  it("happy path returns scope_clean: true with master_card_doc", async () => {
    const sub = generateKeypair();
    const holder = generateKeypair();
    const app = generateKeypair();
    const certRoot = generateKeypair();
    const issuer = generateKeypair();
    const press = generateKeypair();

    const subDoc = makeSubCardDoc(holder.publicKey, holder.secretKey, app.publicKey, app.secretKey, sub.publicKey);
    const masterDoc = makeCardDoc(holder.publicKey, issuer.secretKey, holder.secretKey, press.secretKey);
    // Add sub-card's public key to active_subcards
    masterDoc.active_subcards = [Buffer.from(sub.publicKey).toString("base64url")];
    // App card chains to certRoot via ancestry_pubkeys[0]
    const appCardDoc = makeCardDoc(app.publicKey, certRoot.secretKey, app.secretKey, press.secretKey, [Buffer.from(certRoot.publicKey).toString("base64url")]);

    const encSubDoc = encryptForCard(sub.publicKey, new TextEncoder().encode(JSON.stringify(subDoc)));
    const encMasterDoc = encryptForCard(holder.publicKey, new TextEncoder().encode(JSON.stringify(masterDoc)));
    const encAppDoc = encryptForCard(app.publicKey, new TextEncoder().encode(JSON.stringify(appCardDoc)));

    const rpc = mockRpc({
      getCardEntry: vi.fn().mockImplementation((addr: string) => {
        if (addr === sub.address) return Promise.resolve({ exists: true, log_head_cid: "QmSub", policy_address: "0x", last_press_address: "0x", forward_to: null });
        if (addr === holder.address) return Promise.resolve({ exists: true, log_head_cid: "QmMaster", policy_address: "0x", last_press_address: "0x", forward_to: null });
        if (addr === app.address) return Promise.resolve({ exists: true, log_head_cid: "QmApp", policy_address: "0x", last_press_address: "0x", forward_to: null });
        return Promise.resolve(null);
      }),
      getSubCardEntry: vi.fn().mockResolvedValue({ master_card_address: holder.address, registration_log_head: "0x", sub_card_doc_cid: "QmSub", active: true, registered_at: "2026-01-01T00:00:00Z", deregistered_at: null } as SubCardEntry),
    });
    const ipfs = mockIpfs({ QmSub: encSubDoc, QmMaster: encMasterDoc, QmApp: encAppDoc });
    const result = await verifyStage2(sub.publicKey, rpc, ipfs, { appCertificationRoot: certRoot.address });
    expect(result.scope_clean).toBe(true);
    expect(result.master_card_doc).toBeDefined();
    expect(result.app_card_chain_valid).toBe(true);
  });
});

describe("stage2 — app_card chain walk", () => {
  it("direct hop: app_card ancestry_pubkeys[0] hashes to appCertificationRoot → app_card_chain_valid: true", async () => {
    const sub = generateKeypair();
    const holder = generateKeypair();
    const app = generateKeypair();
    const certRoot = generateKeypair();
    const issuer = generateKeypair();
    const press = generateKeypair();

    const subDoc = makeSubCardDoc(holder.publicKey, holder.secretKey, app.publicKey, app.secretKey, sub.publicKey);
    const masterDoc = makeCardDoc(holder.publicKey, issuer.secretKey, holder.secretKey, press.secretKey);
    // Add sub-card's public key to active_subcards
    masterDoc.active_subcards = [Buffer.from(sub.publicKey).toString("base64url")];
    const appCardDoc = makeCardDoc(app.publicKey, certRoot.secretKey, app.secretKey, press.secretKey, [Buffer.from(certRoot.publicKey).toString("base64url")]);

    const encSubDoc = encryptForCard(sub.publicKey, new TextEncoder().encode(JSON.stringify(subDoc)));
    const encMasterDoc = encryptForCard(holder.publicKey, new TextEncoder().encode(JSON.stringify(masterDoc)));
    const encAppDoc = encryptForCard(app.publicKey, new TextEncoder().encode(JSON.stringify(appCardDoc)));

    const rpc = mockRpc({
      getCardEntry: vi.fn().mockImplementation((addr: string) => {
        if (addr === sub.address) return Promise.resolve({ exists: true, log_head_cid: "QmSub", policy_address: "0x", last_press_address: "0x", forward_to: null });
        if (addr === holder.address) return Promise.resolve({ exists: true, log_head_cid: "QmMaster", policy_address: "0x", last_press_address: "0x", forward_to: null });
        if (addr === app.address) return Promise.resolve({ exists: true, log_head_cid: "QmApp", policy_address: "0x", last_press_address: "0x", forward_to: null });
        return Promise.resolve(null);
      }),
      getSubCardEntry: vi.fn().mockResolvedValue({ master_card_address: holder.address, registration_log_head: "0x", sub_card_doc_cid: "QmSub", active: true, registered_at: "2026-01-01T00:00:00Z", deregistered_at: null } as SubCardEntry),
    });
    const ipfs = mockIpfs({ QmSub: encSubDoc, QmMaster: encMasterDoc, QmApp: encAppDoc });

    const result = await verifyStage2(sub.publicKey, rpc, ipfs, { appCertificationRoot: certRoot.address });
    expect(result.scope_clean).toBe(true);
    expect(result.app_card_chain_valid).toBe(true);
    expect(result.errors.some((e) => e.code === "APP_CARD_CHAIN_NOT_TRUSTED")).toBe(false);
  });

  it("multi-hop: app_card → intermediate → appCertificationRoot → app_card_chain_valid: true", async () => {
    const sub = generateKeypair();
    const holder = generateKeypair();
    const app = generateKeypair();
    const intermediate = generateKeypair();
    const certRoot = generateKeypair();
    const issuer = generateKeypair();
    const press = generateKeypair();

    const subDoc = makeSubCardDoc(holder.publicKey, holder.secretKey, app.publicKey, app.secretKey, sub.publicKey);
    const masterDoc = makeCardDoc(holder.publicKey, issuer.secretKey, holder.secretKey, press.secretKey);
    // Add sub-card's public key to active_subcards
    masterDoc.active_subcards = [Buffer.from(sub.publicKey).toString("base64url")];
    // app card chains to intermediate
    const appCardDoc = makeCardDoc(app.publicKey, intermediate.secretKey, app.secretKey, press.secretKey, [Buffer.from(intermediate.publicKey).toString("base64url")]);
    // intermediate card chains to certRoot
    const intermediateDoc = makeCardDoc(intermediate.publicKey, certRoot.secretKey, intermediate.secretKey, press.secretKey, [Buffer.from(certRoot.publicKey).toString("base64url")]);

    const encSubDoc = encryptForCard(sub.publicKey, new TextEncoder().encode(JSON.stringify(subDoc)));
    const encMasterDoc = encryptForCard(holder.publicKey, new TextEncoder().encode(JSON.stringify(masterDoc)));
    const encAppDoc = encryptForCard(app.publicKey, new TextEncoder().encode(JSON.stringify(appCardDoc)));
    const encIntermediateDoc = encryptForCard(intermediate.publicKey, new TextEncoder().encode(JSON.stringify(intermediateDoc)));

    const rpc = mockRpc({
      getCardEntry: vi.fn().mockImplementation((addr: string) => {
        if (addr === sub.address) return Promise.resolve({ exists: true, log_head_cid: "QmSub", policy_address: "0x", last_press_address: "0x", forward_to: null });
        if (addr === holder.address) return Promise.resolve({ exists: true, log_head_cid: "QmMaster", policy_address: "0x", last_press_address: "0x", forward_to: null });
        if (addr === app.address) return Promise.resolve({ exists: true, log_head_cid: "QmApp", policy_address: "0x", last_press_address: "0x", forward_to: null });
        if (addr === intermediate.address) return Promise.resolve({ exists: true, log_head_cid: "QmIntermediate", policy_address: "0x", last_press_address: "0x", forward_to: null });
        return Promise.resolve(null);
      }),
      getSubCardEntry: vi.fn().mockResolvedValue({ master_card_address: holder.address, registration_log_head: "0x", sub_card_doc_cid: "QmSub", active: true, registered_at: "2026-01-01T00:00:00Z", deregistered_at: null } as SubCardEntry),
    });
    const ipfs = mockIpfs({ QmSub: encSubDoc, QmMaster: encMasterDoc, QmApp: encAppDoc, QmIntermediate: encIntermediateDoc });

    const result = await verifyStage2(sub.publicKey, rpc, ipfs, { appCertificationRoot: certRoot.address });
    expect(result.scope_clean).toBe(true);
    expect(result.app_card_chain_valid).toBe(true);
  });

  it("chain does not reach appCertificationRoot → scope_clean: false, APP_CARD_CHAIN_NOT_TRUSTED", async () => {
    const sub = generateKeypair();
    const holder = generateKeypair();
    const app = generateKeypair();
    const wrongRoot = generateKeypair();
    const certRoot = generateKeypair();
    const issuer = generateKeypair();
    const press = generateKeypair();

    const subDoc = makeSubCardDoc(holder.publicKey, holder.secretKey, app.publicKey, app.secretKey, sub.publicKey);
    const masterDoc = makeCardDoc(holder.publicKey, issuer.secretKey, holder.secretKey, press.secretKey);
    // Add sub-card's public key to active_subcards
    masterDoc.active_subcards = [Buffer.from(sub.publicKey).toString("base64url")];
    // App card terminates at wrongRoot, not certRoot
    const appCardDoc = makeCardDoc(app.publicKey, wrongRoot.secretKey, app.secretKey, press.secretKey, []);

    const encSubDoc = encryptForCard(sub.publicKey, new TextEncoder().encode(JSON.stringify(subDoc)));
    const encMasterDoc = encryptForCard(holder.publicKey, new TextEncoder().encode(JSON.stringify(masterDoc)));
    const encAppDoc = encryptForCard(app.publicKey, new TextEncoder().encode(JSON.stringify(appCardDoc)));

    const rpc = mockRpc({
      getCardEntry: vi.fn().mockImplementation((addr: string) => {
        if (addr === sub.address) return Promise.resolve({ exists: true, log_head_cid: "QmSub", policy_address: "0x", last_press_address: "0x", forward_to: null });
        if (addr === holder.address) return Promise.resolve({ exists: true, log_head_cid: "QmMaster", policy_address: "0x", last_press_address: "0x", forward_to: null });
        if (addr === app.address) return Promise.resolve({ exists: true, log_head_cid: "QmApp", policy_address: "0x", last_press_address: "0x", forward_to: null });
        return Promise.resolve(null);
      }),
      getSubCardEntry: vi.fn().mockResolvedValue({ master_card_address: holder.address, registration_log_head: "0x", sub_card_doc_cid: "QmSub", active: true, registered_at: "2026-01-01T00:00:00Z", deregistered_at: null } as SubCardEntry),
    });
    const ipfs = mockIpfs({ QmSub: encSubDoc, QmMaster: encMasterDoc, QmApp: encAppDoc });

    const result = await verifyStage2(sub.publicKey, rpc, ipfs, { appCertificationRoot: certRoot.address });
    expect(result.scope_clean).toBe(false);
    expect(result.app_card_chain_valid).toBe(false);
    expect(result.errors.some((e) => e.code === "APP_CARD_CHAIN_NOT_TRUSTED")).toBe(true);
  });

  it("sub-card not in master's active_subcards returns SUB_CARD_NOT_IN_ACTIVE_DIRECTORY", async () => {
    const sub = generateKeypair();
    const holder = generateKeypair();
    const app = generateKeypair();
    const issuer = generateKeypair();
    const press = generateKeypair();

    const subDoc = makeSubCardDoc(holder.publicKey, holder.secretKey, app.publicKey, app.secretKey, sub.publicKey);
    const masterDoc = makeCardDoc(holder.publicKey, issuer.secretKey, holder.secretKey, press.secretKey);
    // Master doc has empty or missing active_subcards, so sub-card won't be found
    masterDoc.active_subcards = [];

    const encSubDoc = encryptForCard(sub.publicKey, new TextEncoder().encode(JSON.stringify(subDoc)));
    const encMasterDoc = encryptForCard(holder.publicKey, new TextEncoder().encode(JSON.stringify(masterDoc)));

    const rpc = mockRpc({
      getCardEntry: vi.fn().mockImplementation((addr: string) => {
        if (addr === sub.address) return Promise.resolve({ exists: true, log_head_cid: "QmSub", policy_address: "0x", last_press_address: "0x", forward_to: null });
        if (addr === holder.address) return Promise.resolve({ exists: true, log_head_cid: "QmMaster", policy_address: "0x", last_press_address: "0x", forward_to: null });
        return Promise.resolve(null);
      }),
      getSubCardEntry: vi.fn().mockResolvedValue({
        master_card_address: holder.address,
        registration_log_head: "0x",
        sub_card_doc_cid: "QmSub",
        active: true,
        registered_at: "2026-01-01T00:00:00Z",
        deregistered_at: null,
      } as SubCardEntry),
    });
    const ipfs = mockIpfs({ QmSub: encSubDoc, QmMaster: encMasterDoc });
    const result = await verifyStage2(sub.publicKey, rpc, ipfs, { appCertificationRoot: DUMMY_CERT_ROOT });
    expect(result.scope_clean).toBe(false);
    expect(result.errors.some((e) => e.code === "SUB_CARD_NOT_IN_ACTIVE_DIRECTORY")).toBe(true);
  });

  it("constructor rejects missing appCertificationRoot", () => {
    expect(
      () => new CardVerifier({ rpc: mockRpc(), ipfs: mockIpfs(), appCertificationRoot: undefined as unknown as string })
    ).toThrow(CardProtocolError);
  });
});
