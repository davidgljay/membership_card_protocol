import { describe, it, expect, vi } from "vitest";
import { verifyStage3 } from "../../src/stages/stage3.js";
import { generateKeypair, encryptForCard, makeCardDoc } from "../fixtures.js";
import type { RpcProvider, IpfsProvider, CardDocument } from "../../src/types.js";

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

describe("stage3 — chain walk", () => {
  it("chain terminates at trusted root in config", async () => {
    const root = generateKeypair();
    const child = generateKeypair();
    const grandchild = generateKeypair();
    const press = generateKeypair();

    // grandchild has ancestry_pubkeys pointing to child, child is in trustedRoots
    const grandchildDoc: CardDocument = makeCardDoc(
      grandchild.publicKey, child.secretKey, grandchild.secretKey, press.secretKey,
      [Buffer.from(child.publicKey).toString("base64url")]
    );

    const rpc = mockRpc({
      isPolicyAuthorizer: vi.fn().mockResolvedValue(false),
      getCardEntry: vi.fn().mockImplementation((addr: string) => {
        if (addr === child.address) return Promise.resolve({ exists: true, log_head_cid: "QmChild", policy_address: "0x", last_press_address: "0x", forward_to: null });
        return Promise.resolve(null);
      }),
    });
    const ipfs = mockIpfs();

    const result = await verifyStage3(grandchildDoc, grandchild.address, rpc, ipfs, {
      trustedRoots: [child.address],
      maxChainDepth: 64,
    });
    expect(result.chain_reaches_trusted_root).toBe(true);
    expect(result.chain_card_addresses).toContain(child.address);
  });

  it("chain exhausted without trusted root returns false", async () => {
    const issuer = generateKeypair();
    const holder = generateKeypair();
    const press = generateKeypair();

    // ancestry_pubkeys is empty and card is not in PolicyAuthorizerKeys
    const cardDoc = makeCardDoc(holder.publicKey, issuer.secretKey, holder.secretKey, press.secretKey, []);
    const rpc = mockRpc({ isPolicyAuthorizer: vi.fn().mockResolvedValue(false) });
    const result = await verifyStage3(cardDoc, holder.address, rpc, mockIpfs(), { trustedRoots: [], maxChainDepth: 64 });
    expect(result.chain_reaches_trusted_root).toBe(false);
  });

  it("card with empty ancestry and isPolicyAuthorizer=true reaches trusted root", async () => {
    const issuer = generateKeypair();
    const holder = generateKeypair();
    const press = generateKeypair();

    const cardDoc = makeCardDoc(holder.publicKey, issuer.secretKey, holder.secretKey, press.secretKey, []);
    const rpc = mockRpc({ isPolicyAuthorizer: vi.fn().mockResolvedValue(true) });
    const result = await verifyStage3(cardDoc, holder.address, rpc, mockIpfs(), { trustedRoots: [], maxChainDepth: 64 });
    expect(result.chain_reaches_trusted_root).toBe(true);
  });

  it("depth exceeded returns chain_reaches_trusted_root: false with CHAIN_DEPTH_EXCEEDED", async () => {
    const issuer = generateKeypair();
    const holder = generateKeypair();
    const press = generateKeypair();
    const fakeAncestor = generateKeypair();

    // Card with a non-empty ancestry_pubkeys, so it keeps walking
    const cardDoc = makeCardDoc(
      holder.publicKey, issuer.secretKey, holder.secretKey, press.secretKey,
      [Buffer.from(fakeAncestor.publicKey).toString("base64url")]
    );
    const fakeEncDoc = encryptForCard(
      fakeAncestor.publicKey,
      new TextEncoder().encode(JSON.stringify(makeCardDoc(
        fakeAncestor.publicKey, issuer.secretKey, fakeAncestor.secretKey, press.secretKey,
        [Buffer.from(fakeAncestor.publicKey).toString("base64url")] // points to itself
      )))
    );
    const rpc = mockRpc({
      isPolicyAuthorizer: vi.fn().mockResolvedValue(false),
      getCardEntry: vi.fn().mockResolvedValue({ exists: true, log_head_cid: "QmAncestor", policy_address: "0x", last_press_address: "0x", forward_to: null }),
    });
    const ipfs = mockIpfs({ QmAncestor: fakeEncDoc });

    const result = await verifyStage3(cardDoc, holder.address, rpc, ipfs, {
      trustedRoots: [],
      maxChainDepth: 2,
    });
    expect(result.chain_reaches_trusted_root).toBe(false);
    expect(result.errors.some((e) => e.code === "CHAIN_DEPTH_EXCEEDED")).toBe(true);
  });
});
