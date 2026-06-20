/**
 * Full end-to-end integration test.
 *
 * Scenario: a sub-card signs an envelope. The sub-card's master card has one ancestor
 * which is a trusted root. No revocations. Policy has no required fields. Press is authorized.
 *
 * All crypto is real (no mocking of crypto primitives). Only RPC and IPFS are mocked.
 */
import { describe, it, expect, vi } from "vitest";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { CardVerifier } from "../../src/CardVerifier.js";
import { canonicalize } from "../../src/canonicalize.js";
import {
  generateKeypair,
  encryptForCard,
  makeCardDoc,
  makeSubCardDoc,
} from "../fixtures.js";
import type {
  RpcProvider,
  IpfsProvider,
  SignedMessageEnvelope,
  SubCardEntry,
  CardEntry,
  PressAuthEntry,
} from "../../src/types.js";

describe("full pipeline integration", () => {
  it("verifies a sub-card-signed envelope end-to-end", async () => {
    // Build the trust chain: root ← parent ← master ← sub-card
    const root = generateKeypair();    // trusted root (in PolicyAuthorizerKeys)
    const parent = generateKeypair();  // parent card
    const holder = generateKeypair();  // master card holder (primary card)
    const sub = generateKeypair();     // sub-card (the signer)
    const app = generateKeypair();     // app that requested the sub-card
    const issuer = generateKeypair();  // issuer (not the root itself)
    const press = generateKeypair();   // press that registered the cards

    // Policy document (no required fields → always compliant)
    const policyDoc = { field_definitions: {} };
    const policyBytes = new TextEncoder().encode(JSON.stringify(policyDoc));
    const POLICY_CID = "QmPolicy";

    // Parent card: ancestry_pubkeys = [root pubkey], since root is the trusted parent
    const parentDoc = makeCardDoc(
      parent.publicKey,
      root.secretKey,
      parent.secretKey,
      press.secretKey,
      [Buffer.from(root.publicKey).toString("base64url")]
    );
    parentDoc.policy_id = POLICY_CID;
    const PARENT_CID = "QmParent";

    // Master card: ancestry_pubkeys = [parent pubkey]
    const masterDoc = makeCardDoc(
      holder.publicKey,
      parent.secretKey,
      holder.secretKey,
      press.secretKey,
      [Buffer.from(parent.publicKey).toString("base64url")]
    );
    masterDoc.policy_id = POLICY_CID;
    const MASTER_CID = "QmMaster";

    // Sub-card document
    const subDoc = makeSubCardDoc(
      holder.publicKey,
      holder.secretKey,
      app.publicKey,
      app.secretKey,
      sub.publicKey
    );
    const SUB_CID = "QmSub";

    // Encrypt the documents for IPFS
    const encSubDoc = encryptForCard(sub.publicKey, new TextEncoder().encode(JSON.stringify(subDoc)));
    const encMasterDoc = encryptForCard(holder.publicKey, new TextEncoder().encode(JSON.stringify(masterDoc)));
    const encParentDoc = encryptForCard(parent.publicKey, new TextEncoder().encode(JSON.stringify(parentDoc)));

    // Sign the envelope with the sub-card key
    const payload = { message: "hello world", timestamp: "2026-06-20T00:00:00Z" };
    const canonical = canonicalize(payload);
    const sig = ml_dsa44.sign(canonical, sub.secretKey);
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
        return Promise.resolve(null);
      }),
      isPolicyAuthorizer: vi.fn().mockImplementation((addr: string) =>
        Promise.resolve(addr === root.address)
      ),
      getPressAuthorization: vi.fn().mockResolvedValue(pressEntry),
      getSubCardEntry: vi.fn().mockImplementation((addr: string) =>
        addr === sub.address ? Promise.resolve(subCardEntry) : Promise.resolve(null)
      ),
      getLogEntries: vi.fn().mockResolvedValue([]),
      getEasAnnotations: vi.fn().mockResolvedValue([]),
    };

    const ipfs: IpfsProvider = {
      fetch: vi.fn().mockImplementation((cid: string) => {
        if (cid === SUB_CID) return Promise.resolve(encSubDoc);
        if (cid === MASTER_CID) return Promise.resolve(encMasterDoc);
        if (cid === PARENT_CID) return Promise.resolve(encParentDoc);
        if (cid === POLICY_CID) return Promise.resolve(policyBytes);
        return Promise.reject(new Error(`CID not found: ${cid}`));
      }),
    };

    const verifier = new CardVerifier({ rpc, ipfs, trustedRoots: [root.address] });
    const result = await verifier.verifyEnvelope(envelope);

    expect(result.envelope_id).toMatch(/^[0-9a-f]{64}$/);
    expect(result.signatures).toHaveLength(1);

    const sig0 = result.signatures[0]!;
    expect(sig0.signature_valid).toBe(true);
    expect(sig0.scope_clean).toBe(true);
    expect(sig0.chain_reaches_trusted_root).toBe(true);
    expect(sig0.is_currently_valid).toBe(true);
    expect(sig0.was_valid_at_signing_time).toBe(true);
    expect(sig0.revocation.status).toBe("not_revoked");
    expect(sig0.policy_compliant).toBe(true);
    expect(sig0.press_subsequently_revoked).toBe(false);
    expect(sig0.errors.filter((e) => e.stage !== 5 || e.code !== "NON_COMPLIANCE_REPORT_FAILED")).toHaveLength(0);
  });
});
