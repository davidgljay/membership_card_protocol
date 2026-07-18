/**
 * Tests for the `returnChain` and `conditions` (policy_match) features added on top
 * of the existing pipeline. Reuses the same trust-chain shape as full-pipeline.test.ts:
 * root (trusted) ← parent ← master ← sub-card (the signer).
 */
import { describe, it, expect, vi } from "vitest";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { CardVerifier } from "../../src/CardVerifier.js";
import { canonicalize } from "../../src/canonicalize.js";
import { generateKeypair, encryptForCard, makeCardDoc, makeSubCardDoc } from "../fixtures.js";
import type {
  RpcProvider,
  IpfsProvider,
  SignedMessageEnvelope,
  SubCardEntry,
  CardEntry,
  PressAuthEntry,
} from "../../src/types.js";

function buildScenario(
  masterExtra: Record<string, unknown> = {},
  sharedAppCertRoot?: ReturnType<typeof generateKeypair>,
  cidPrefix = ""
) {
  const root = generateKeypair();
  const parent = generateKeypair();
  const holder = generateKeypair();
  const sub = generateKeypair();
  const app = generateKeypair();
  const appCertRoot = sharedAppCertRoot ?? generateKeypair();
  const press = generateKeypair();

  const policyDoc = { field_definitions: {} };
  const policyBytes = new TextEncoder().encode(JSON.stringify(policyDoc));
  const POLICY_CID = `${cidPrefix}QmPolicy`;

  const parentDoc = makeCardDoc(
    parent.publicKey,
    root.secretKey,
    parent.secretKey,
    press.secretKey,
    [Buffer.from(root.publicKey).toString("base64url")]
  );
  parentDoc.policy_id = POLICY_CID;
  const PARENT_CID = `${cidPrefix}QmParent`;

  const masterDoc = makeCardDoc(
    holder.publicKey,
    parent.secretKey,
    holder.secretKey,
    press.secretKey,
    [Buffer.from(parent.publicKey).toString("base64url")],
    masterExtra
  );
  masterDoc.policy_id = POLICY_CID;
  masterDoc.active_subcards = [Buffer.from(sub.publicKey).toString("base64url")];
  const MASTER_CID = `${cidPrefix}QmMaster`;

  const subDoc = makeSubCardDoc(holder.publicKey, holder.secretKey, app.publicKey, app.secretKey, sub.publicKey);
  const SUB_CID = `${cidPrefix}QmSub`;

  const appCardDoc = makeCardDoc(
    app.publicKey,
    appCertRoot.secretKey,
    app.secretKey,
    press.secretKey,
    [Buffer.from(appCertRoot.publicKey).toString("base64url")]
  );
  const APP_CID = `${cidPrefix}QmApp`;

  const encSubDoc = encryptForCard(sub.publicKey, new TextEncoder().encode(JSON.stringify(subDoc)));
  const encMasterDoc = encryptForCard(holder.publicKey, new TextEncoder().encode(JSON.stringify(masterDoc)));
  const encParentDoc = encryptForCard(parent.publicKey, new TextEncoder().encode(JSON.stringify(parentDoc)));
  const encAppDoc = encryptForCard(app.publicKey, new TextEncoder().encode(JSON.stringify(appCardDoc)));

  const payload = { message: "hello world", protocol_version: "0.1", timestamp: "2026-06-20T00:00:00Z" };
  const sig = ml_dsa44.sign(canonicalize(payload), sub.secretKey);
  const envelope: SignedMessageEnvelope = {
    payload,
    signatures: [
      {
        public_key: Buffer.from(sub.publicKey).toString("base64url"),
        signature: Buffer.from(sig).toString("base64url"),
      },
    ],
  };

  const subCardEntry: SubCardEntry = {
    master_card_address: holder.address,
    registration_log_head: "0x",
    sub_card_doc_cid: SUB_CID,
    active: true,
    registered_at: "2026-01-01T00:00:00Z",
    deregistered_at: null,
  };

  const pressEntry: PressAuthEntry = {
    press_public_key: Buffer.from(press.publicKey).toString("hex"),
    mldsa44_key_hash: "0x",
    active: true,
    authorized_at: "2026-01-01T00:00:00Z",
    revoked_at: null,
  };

  function makeCardEntry(cid: string): CardEntry {
    return { log_head_cid: cid, policy_address: "0x" + "f".repeat(64), last_press_address: press.address, forward_to: null, exists: true };
  }

  const rpc: RpcProvider = {
    getCardEntry: vi.fn().mockImplementation((addr: string) => {
      if (addr === sub.address) return Promise.resolve(makeCardEntry(SUB_CID));
      if (addr === holder.address) return Promise.resolve(makeCardEntry(MASTER_CID));
      if (addr === parent.address) return Promise.resolve(makeCardEntry(PARENT_CID));
      if (addr === app.address) return Promise.resolve(makeCardEntry(APP_CID));
      return Promise.resolve(null);
    }),
    isPolicyAuthorizer: vi.fn().mockImplementation((addr: string) => Promise.resolve(addr === root.address)),
    getPressAuthorization: vi.fn().mockResolvedValue(pressEntry),
    getSubCardEntry: vi.fn().mockImplementation((addr: string) =>
      addr === sub.address ? Promise.resolve(subCardEntry) : Promise.resolve(null)
    ),
    getCardEventLog: vi.fn().mockResolvedValue([]),
    getEasAnnotations: vi.fn().mockResolvedValue([]),
  };

  const ipfs: IpfsProvider = {
    fetch: vi.fn().mockImplementation((cid: string) => {
      if (cid === SUB_CID) return Promise.resolve(encSubDoc);
      if (cid === MASTER_CID) return Promise.resolve(encMasterDoc);
      if (cid === PARENT_CID) return Promise.resolve(encParentDoc);
      if (cid === APP_CID) return Promise.resolve(encAppDoc);
      if (cid === POLICY_CID) return Promise.resolve(policyBytes);
      return Promise.reject(new Error(`CID not found: ${cid}`));
    }),
  };

  return { rpc, ipfs, envelope, root, parent, holder, sub, appCertRoot, POLICY_CID, MASTER_CID, PARENT_CID };
}

describe("returnChain", () => {
  it("omits `chain` entirely when returnChain is not set", async () => {
    const { rpc, ipfs, envelope, root, appCertRoot } = buildScenario();
    const verifier = new CardVerifier({ rpc, ipfs, trustedRoots: [root.address], appCertificationRoot: appCertRoot.address });
    const result = await verifier.verifyEnvelope(envelope);
    const sig0 = result.signatures[0]!;
    expect("chain" in sig0).toBe(false);
  });

  it("returns the walked chain (master then parent, root excluded) when returnChain is true", async () => {
    const { rpc, ipfs, envelope, root, holder, parent, appCertRoot, MASTER_CID, PARENT_CID } = buildScenario();
    const verifier = new CardVerifier({
      rpc,
      ipfs,
      trustedRoots: [root.address],
      appCertificationRoot: appCertRoot.address,
      returnChain: true,
    });
    const result = await verifier.verifyEnvelope(envelope);
    const sig0 = result.signatures[0]!;
    expect(sig0.chain).toBeDefined();
    expect(sig0.chain).toHaveLength(2);
    // The chain walk starts from the master card's own document and address (a
    // sub-card has no ancestry of its own), so the first hop's card_address must
    // correspond to the same card as its card_content.
    expect(sig0.chain![0]!.card_address).toBe(holder.address);
    expect(sig0.chain![1]!.card_address).toBe(parent.address);
    expect(sig0.chain![0]!.card_content["policy_id"]).toBeDefined();
    void MASTER_CID;
    void PARENT_CID;
  });

  it("fully asserts chain shape: card_address, public_key, and card_content at each hop", async () => {
    const { rpc, ipfs, envelope, root, holder, parent, appCertRoot } = buildScenario();
    const verifier = new CardVerifier({
      rpc,
      ipfs,
      trustedRoots: [root.address],
      appCertificationRoot: appCertRoot.address,
      returnChain: true,
    });
    const result = await verifier.verifyEnvelope(envelope);
    const sig0 = result.signatures[0]!;
    expect(sig0.chain).toBeDefined();
    expect(sig0.chain!.length).toBe(2);

    // First hop: master card
    const firstHop = sig0.chain![0]!;
    expect(firstHop.card_address).toBe(holder.address);
    expect(firstHop.public_key).toBeDefined();
    expect(typeof firstHop.public_key).toBe("string");
    expect(firstHop.public_key.length).toBeGreaterThan(0);
    expect(firstHop.card_content).toBeDefined();
    expect(typeof firstHop.card_content).toBe("object");
    expect(firstHop.card_content["policy_id"]).toBeDefined();
    expect(firstHop.card_content["issued_at"]).toBeDefined();
    expect(firstHop.card_content["ancestry_pubkeys"]).toBeDefined();

    // Second hop: parent card
    const secondHop = sig0.chain![1]!;
    expect(secondHop.card_address).toBe(parent.address);
    expect(secondHop.public_key).toBeDefined();
    expect(typeof secondHop.public_key).toBe("string");
    expect(secondHop.public_key.length).toBeGreaterThan(0);
    expect(secondHop.card_content).toBeDefined();
    expect(typeof secondHop.card_content).toBe("object");
    expect(secondHop.card_content["policy_id"]).toBeDefined();
    expect(secondHop.card_content["issued_at"]).toBeDefined();
  });

  it("returns partial chain when walk fails mid-way (e.g., IPFS fetch error)", async () => {
    const { rpc, ipfs, envelope, root, holder, parent, appCertRoot, MASTER_CID, PARENT_CID } = buildScenario();
    // Mock the IPFS provider to fail when fetching the parent card, simulating a mid-walk failure
    const failingIpfs: IpfsProvider = {
      fetch: vi.fn().mockImplementation((cid: string) => {
        if (cid === MASTER_CID || cid === "QmPolicy") {
          return (ipfs.fetch as (c: string) => Promise<Uint8Array>)(cid);
        }
        if (cid === PARENT_CID) {
          // Simulate IPFS fetch failure mid-walk
          return Promise.reject(new Error("IPFS fetch failed"));
        }
        return (ipfs.fetch as (c: string) => Promise<Uint8Array>)(cid);
      }),
    };

    const verifier = new CardVerifier({
      rpc,
      ipfs: failingIpfs,
      trustedRoots: [root.address],
      appCertificationRoot: appCertRoot.address,
      returnChain: true,
    });

    const result = await verifier.verifyEnvelope(envelope);
    const sig0 = result.signatures[0]!;
    // Partial chain should still be returned even though the walk failed
    expect(sig0.chain).toBeDefined();
    // We got the master card before the failure, so at least one link
    expect(sig0.chain!.length).toBeGreaterThanOrEqual(1);
    expect(sig0.chain![0]!.card_address).toBe(holder.address);
    // The chain walk should have failed; chain_reaches_trusted_root should be false
    expect(sig0.chain_reaches_trusted_root).toBe(false);
  });
});

describe("policy_match", () => {
  it("is null when conditions is not supplied", async () => {
    const { rpc, ipfs, envelope, root, appCertRoot } = buildScenario();
    const verifier = new CardVerifier({ rpc, ipfs, trustedRoots: [root.address], appCertificationRoot: appCertRoot.address });
    const result = await verifier.verifyEnvelope(envelope);
    expect(result.signatures[0]!.policy_match).toBeNull();
    expect(result.policy_match).toBeNull();
  });

  it("is true when the chain includes a card matching policy_id (no field_match)", async () => {
    const { rpc, ipfs, envelope, root, appCertRoot, POLICY_CID } = buildScenario();
    const verifier = new CardVerifier({
      rpc,
      ipfs,
      trustedRoots: [root.address],
      appCertificationRoot: appCertRoot.address,
      conditions: { policy_id: POLICY_CID },
    });
    const result = await verifier.verifyEnvelope(envelope);
    expect(result.signatures[0]!.policy_match).toEqual({ matched: true });
    expect(result.policy_match).toEqual({ matched: true });
  });

  it("is false when no card in the chain matches policy_id", async () => {
    const { rpc, ipfs, envelope, root, appCertRoot } = buildScenario();
    const verifier = new CardVerifier({
      rpc,
      ipfs,
      trustedRoots: [root.address],
      appCertificationRoot: appCertRoot.address,
      conditions: { policy_id: "QmSomeOtherPolicy" },
    });
    const result = await verifier.verifyEnvelope(envelope);
    expect(result.signatures[0]!.policy_match).toEqual({ matched: false, reason: "no_policy_match" });
    expect(result.policy_match).toEqual({ matched: false, reason: "no_policy_match" });
  });

  it("plain-string field_match is exact-match shorthand", async () => {
    const { rpc, ipfs, envelope, root, appCertRoot, POLICY_CID } = buildScenario({ user_type: "admin" });
    const verifier = new CardVerifier({
      rpc,
      ipfs,
      trustedRoots: [root.address],
      appCertificationRoot: appCertRoot.address,
      conditions: { policy_id: POLICY_CID, field_match: { user_type: "admin" } },
    });
    const result = await verifier.verifyEnvelope(envelope);
    expect(result.signatures[0]!.policy_match).toEqual({ matched: true });
  });

  it("plain-string field_match with a non-matching value is false", async () => {
    const { rpc, ipfs, envelope, root, appCertRoot, POLICY_CID } = buildScenario({ user_type: "member" });
    const verifier = new CardVerifier({
      rpc,
      ipfs,
      trustedRoots: [root.address],
      appCertificationRoot: appCertRoot.address,
      conditions: { policy_id: POLICY_CID, field_match: { user_type: "admin" } },
    });
    const result = await verifier.verifyEnvelope(envelope);
    expect(result.signatures[0]!.policy_match).toEqual({ matched: false, reason: "field_mismatch" });
  });

  it("regex field_match is supported as the escape hatch", async () => {
    const { rpc, ipfs, envelope, root, appCertRoot, POLICY_CID } = buildScenario({ user_type: "super-admin" });
    const verifier = new CardVerifier({
      rpc,
      ipfs,
      trustedRoots: [root.address],
      appCertificationRoot: appCertRoot.address,
      conditions: { policy_id: POLICY_CID, field_match: { user_type: { regex: "^(admin|super-admin)$" } } },
    });
    const result = await verifier.verifyEnvelope(envelope);
    expect(result.signatures[0]!.policy_match).toEqual({ matched: true });
  });

  it("multiple field_match conditions: all match -> true", async () => {
    const { rpc, ipfs, envelope, root, appCertRoot, POLICY_CID } = buildScenario({
      user_type: "admin",
      department: "engineering",
    });
    const verifier = new CardVerifier({
      rpc,
      ipfs,
      trustedRoots: [root.address],
      appCertificationRoot: appCertRoot.address,
      conditions: {
        policy_id: POLICY_CID,
        field_match: { user_type: "admin", department: "engineering" },
      },
    });
    const result = await verifier.verifyEnvelope(envelope);
    expect(result.signatures[0]!.policy_match).toEqual({ matched: true });
  });

  it("multiple field_match conditions: one non-matching -> false", async () => {
    const { rpc, ipfs, envelope, root, appCertRoot, POLICY_CID } = buildScenario({
      user_type: "admin",
      department: "sales",
    });
    const verifier = new CardVerifier({
      rpc,
      ipfs,
      trustedRoots: [root.address],
      appCertificationRoot: appCertRoot.address,
      conditions: {
        policy_id: POLICY_CID,
        field_match: { user_type: "admin", department: "engineering" },
      },
    });
    const result = await verifier.verifyEnvelope(envelope);
    expect(result.signatures[0]!.policy_match).toEqual({ matched: false, reason: "field_mismatch" });
  });

  it("verifyCard() with conditions and returnChain returns empty chain and false policy_match", async () => {
    const { rpc, ipfs, root, appCertRoot, POLICY_CID, holder } = buildScenario({
      user_type: "admin",
    });
    const verifier = new CardVerifier({
      rpc,
      ipfs,
      trustedRoots: [root.address],
      appCertificationRoot: appCertRoot.address,
      returnChain: true,
      conditions: { policy_id: POLICY_CID, field_match: { user_type: "admin" } },
    });

    // verifyCard takes a bare card address (holder's master card address)
    const result = await verifier.verifyCard(holder.address);
    // When returnChain is true, chain field is present but always empty for verifyCard
    // (no pubkey available from address alone, so no CardDocument can be decrypted)
    expect("chain" in result).toBe(true);
    expect(result.chain).toBeDefined();
    expect(result.chain).toHaveLength(0);
    // When conditions are supplied but no chain can be resolved, policy_match is false
    expect(result.policy_match).toEqual({ matched: false, reason: "no_policy_match" });
  });

  it("verifyCard() without conditions and returnChain returns empty chain and null policy_match", async () => {
    const { rpc, ipfs, root, appCertRoot, holder } = buildScenario();
    const verifier = new CardVerifier({
      rpc,
      ipfs,
      trustedRoots: [root.address],
      appCertificationRoot: appCertRoot.address,
      returnChain: true,
      // no conditions supplied
    });

    const result = await verifier.verifyCard(holder.address);
    expect("chain" in result).toBe(true);
    expect(result.chain).toHaveLength(0);
    expect(result.policy_match).toBeNull();
  });

  it("chain with one link matching different policy_id and second matching target but failing field_match -> field_mismatch", async () => {
    // This test ensures that sawPolicyIdMatch is correctly set only when the target
    // policy_id matches, not when other links match different policy_ids.
    // Chain structure: master (QmAltPolicy) -> parent (QmPolicy, user_type=member)
    // Conditions: { policy_id: QmPolicy, field_match: { user_type: "admin" } }
    // Expected: field_mismatch (parent matches policy_id but field fails)

    const root = generateKeypair();
    const parent = generateKeypair();
    const holder = generateKeypair();
    const sub = generateKeypair();
    const app = generateKeypair();
    const appCertRoot = generateKeypair();
    const press = generateKeypair();

    const policyDoc = { field_definitions: {} };
    const policyBytes = new TextEncoder().encode(JSON.stringify(policyDoc));
    const POLICY_CID = "QmPolicyAlt";

    // Parent card matches target policy_id but fails field_match
    const parentDoc = makeCardDoc(
      parent.publicKey,
      root.secretKey,
      parent.secretKey,
      press.secretKey,
      [Buffer.from(root.publicKey).toString("base64url")]
    );
    parentDoc.policy_id = POLICY_CID;
    parentDoc.user_type = "member"; // fails field_match condition
    const PARENT_CID = "QmParentAlt";

    // Master card has different policy_id (won't match target)
    const masterDoc = makeCardDoc(
      holder.publicKey,
      parent.secretKey,
      holder.secretKey,
      press.secretKey,
      [Buffer.from(parent.publicKey).toString("base64url")]
    );
    masterDoc.policy_id = "QmAltPolicy"; // different from POLICY_CID
    masterDoc.active_subcards = [Buffer.from(sub.publicKey).toString("base64url")];
    const MASTER_CID = "QmMasterAlt";

    const subDoc = makeSubCardDoc(holder.publicKey, holder.secretKey, app.publicKey, app.secretKey, sub.publicKey);
    const SUB_CID = "QmSubAlt";

    const appCardDoc = makeCardDoc(
      app.publicKey,
      appCertRoot.secretKey,
      app.secretKey,
      press.secretKey,
      [Buffer.from(appCertRoot.publicKey).toString("base64url")]
    );
    const APP_CID = "QmAppAlt";

    const encSubDoc = encryptForCard(sub.publicKey, new TextEncoder().encode(JSON.stringify(subDoc)));
    const encMasterDoc = encryptForCard(holder.publicKey, new TextEncoder().encode(JSON.stringify(masterDoc)));
    const encParentDoc = encryptForCard(parent.publicKey, new TextEncoder().encode(JSON.stringify(parentDoc)));
    const encAppDoc = encryptForCard(app.publicKey, new TextEncoder().encode(JSON.stringify(appCardDoc)));

    const payload = { message: "hello world", protocol_version: "0.1", timestamp: "2026-06-20T00:00:00Z" };
    const sig = ml_dsa44.sign(canonicalize(payload), sub.secretKey);
    const envelope: SignedMessageEnvelope = {
      payload,
      signatures: [
        {
          public_key: Buffer.from(sub.publicKey).toString("base64url"),
          signature: Buffer.from(sig).toString("base64url"),
        },
      ],
    };

    const subCardEntry: SubCardEntry = {
      master_card_address: holder.address,
      registration_log_head: "0x",
      sub_card_doc_cid: SUB_CID,
      active: true,
      registered_at: "2026-01-01T00:00:00Z",
      deregistered_at: null,
    };

    const pressEntry: PressAuthEntry = {
      press_public_key: Buffer.from(press.publicKey).toString("hex"),
      mldsa44_key_hash: "0x",
      active: true,
      authorized_at: "2026-01-01T00:00:00Z",
      revoked_at: null,
    };

    function makeCardEntry(cid: string): CardEntry {
      return { log_head_cid: cid, policy_address: "0x" + "f".repeat(64), last_press_address: press.address, forward_to: null, exists: true };
    }

    const rpc: RpcProvider = {
      getCardEntry: vi.fn().mockImplementation((addr: string) => {
        if (addr === sub.address) return Promise.resolve(makeCardEntry(SUB_CID));
        if (addr === holder.address) return Promise.resolve(makeCardEntry(MASTER_CID));
        if (addr === parent.address) return Promise.resolve(makeCardEntry(PARENT_CID));
        if (addr === app.address) return Promise.resolve(makeCardEntry(APP_CID));
        return Promise.resolve(null);
      }),
      isPolicyAuthorizer: vi.fn().mockImplementation((addr: string) => Promise.resolve(addr === root.address)),
      getPressAuthorization: vi.fn().mockResolvedValue(pressEntry),
      getSubCardEntry: vi.fn().mockImplementation((addr: string) =>
        addr === sub.address ? Promise.resolve(subCardEntry) : Promise.resolve(null)
      ),
      getCardEventLog: vi.fn().mockResolvedValue([]),
      getEasAnnotations: vi.fn().mockResolvedValue([]),
    };

    const ipfs: IpfsProvider = {
      fetch: vi.fn().mockImplementation((cid: string) => {
        if (cid === SUB_CID) return Promise.resolve(encSubDoc);
        if (cid === MASTER_CID) return Promise.resolve(encMasterDoc);
        if (cid === PARENT_CID) return Promise.resolve(encParentDoc);
        if (cid === APP_CID) return Promise.resolve(encAppDoc);
        if (cid === POLICY_CID) return Promise.resolve(policyBytes);
        return Promise.reject(new Error(`CID not found: ${cid}`));
      }),
    };

    const verifier = new CardVerifier({
      rpc,
      ipfs,
      trustedRoots: [root.address],
      appCertificationRoot: appCertRoot.address,
      returnChain: true,
      conditions: { policy_id: POLICY_CID, field_match: { user_type: "admin" } },
    });

    const result = await verifier.verifyEnvelope(envelope);
    expect(result.signatures[0]!.policy_match).toEqual({
      matched: false,
      reason: "field_mismatch",
    });
    expect(result.policy_match).toEqual({ matched: false, reason: "field_mismatch" });
  });

  it("envelope-level policy_match is the OR across all signatures", async () => {
    const sharedAppCertRoot = generateKeypair();
    const scenarioA = buildScenario({ user_type: "member" }, sharedAppCertRoot, "a-"); // won't match
    const scenarioB = buildScenario({ user_type: "admin" }, sharedAppCertRoot, "b-"); // will match

    // Merge both envelopes' signatures under a single verifier config so both signers
    // are checked against the same conditions; both scenarios share one appCertRoot so
    // neither signer is hard-rejected on app-card-chain grounds before policy_match
    // can be evaluated.
    const combinedEnvelope: SignedMessageEnvelope = {
      payload: scenarioA.envelope.payload,
      signatures: [...scenarioA.envelope.signatures, ...scenarioB.envelope.signatures],
    };

    const rpc: RpcProvider = {
      getCardEntry: vi.fn().mockImplementation((addr: string) => {
        return (scenarioA.rpc.getCardEntry as (a: string) => Promise<CardEntry | null>)(addr).then((r) =>
          r ? r : (scenarioB.rpc.getCardEntry as (a: string) => Promise<CardEntry | null>)(addr)
        );
      }),
      isPolicyAuthorizer: vi.fn().mockImplementation((addr: string) =>
        Promise.resolve(addr === scenarioA.root.address || addr === scenarioB.root.address)
      ),
      getPressAuthorization: vi.fn().mockResolvedValue({
        press_public_key: "pub",
        mldsa44_key_hash: "hash",
        active: true,
        authorized_at: "2026-01-01T00:00:00Z",
        revoked_at: null,
      }),
      getSubCardEntry: vi.fn().mockImplementation((addr: string) => {
        return (scenarioA.rpc.getSubCardEntry as (a: string) => Promise<SubCardEntry | null>)(addr).then((r) =>
          r ? r : (scenarioB.rpc.getSubCardEntry as (a: string) => Promise<SubCardEntry | null>)(addr)
        );
      }),
      getCardEventLog: vi.fn().mockResolvedValue([]),
      getEasAnnotations: vi.fn().mockResolvedValue([]),
    };

    const ipfs: IpfsProvider = {
      fetch: vi.fn().mockImplementation((cid: string) => {
        return (scenarioA.ipfs.fetch as (c: string) => Promise<Uint8Array>)(cid).catch(() =>
          (scenarioB.ipfs.fetch as (c: string) => Promise<Uint8Array>)(cid)
        );
      }),
    };

    const verifier = new CardVerifier({
      rpc,
      ipfs,
      trustedRoots: [scenarioA.root.address, scenarioB.root.address],
      appCertificationRoot: scenarioA.appCertRoot.address, // both scenarios' app card chains are independent per-signer via appCertificationRoot; scenarioB uses its own appCertRoot so this test only asserts scenarioA's signer fails app-chain trust and is excluded from the OR via its own false chain check — see below.
      conditions: { policy_id: scenarioB.POLICY_CID, field_match: { user_type: "admin" } },
    });

    const result = await verifier.verifyEnvelope(combinedEnvelope);
    expect(result.signatures).toHaveLength(2);
    // At least one signer (scenarioB's, matching "admin") should produce policy_match true,
    // which must OR up to the envelope level regardless of the other signer's outcome.
    expect(result.signatures.some((s) => s.policy_match?.matched === true)).toBe(true);
    expect(result.policy_match).toEqual({ matched: true });
  });
});
