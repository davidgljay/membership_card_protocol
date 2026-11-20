/**
 * Step 6.4: derived cards pass standard verification (Q11). The cards are the ones a real broker issued
 * (`notary/vectors/derived/issued.json`, written by `notary-broker/tests/derive.rs` with NOTARY_WRITE_VECTORS=1).
 * Here they are replayed through the simulated chain's write gate (`src/sim-chain.ts`: press signature, sequence and the
 * step 8 calldata binding), with the `AuthorizePress` entry for the notary under the template created by the simulated
 * registry in test setup; then the TypeScript verifier's stages run over that chain (`CardVerifier.verifyEnvelope`: stages
 * 1 to 6, over an `RpcProvider` and `IpfsProvider` backed by the simulated chain) and `verifyNotaryIssuedCard` (Stage 5
 * step 3a) is called directly. Wiring step 3a into `CardVerifier`, and a real `AuthorizePress`, stay in step 7.1.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { keccak_256, sha3_256 } from "@noble/hashes/sha3";
import { hkdf } from "@noble/hashes/hkdf";
import { CardVerifier, canonicalize } from "@membership-card-protocol/verifier";
import { b64uDecode, b64uEncode, canonicalNotary, cidOfBytes, verifyNotaryIssuedCard } from "@membership-card-protocol/verifier/notary";
import { simulator } from "@membership-card-protocol/notary-attestation";
import { createSimChain } from "../src/sim-chain.ts";
// Stage 5 is reached through `CardVerifier` only for sub-card signers, so it is called directly (the verifier does not export stages)
import { verifyStage5 } from "../../../membership_card_verifier/packages/verifier/dist/stages/stage5.js";

const fx = JSON.parse(readFileSync(new URL("../../vectors/derived/issued.json", import.meta.url), "utf8"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const contentKey = (pub: Uint8Array) => hkdf(sha3_256, pub, undefined, new TextEncoder().encode("card-content-v1"), 32);
const open = (pub: Uint8Array, b: Uint8Array) => {
  const d = createDecipheriv("aes-256-gcm", contentKey(pub), b.subarray(0, 12));
  d.setAuthTag(b.subarray(b.length - 16));
  return JSON.parse(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString());
};
const seal = (pub: Uint8Array, o: unknown) => {
  const n = new Uint8Array(12).fill(7);
  const c = createCipheriv("aes-256-gcm", contentKey(pub), n);
  return new Uint8Array(Buffer.concat([n, c.update(Buffer.from(JSON.stringify(o))), c.final(), c.getAuthTag()]));
};

const tpub = b64uDecode(fx.template_pubkey, 1312);
const T_ADDR = hex(keccak_256(tpub));
const notary = fx.genesis;
const kid = b64uDecode(notary.id_pubkey, 1312);
const chainKey = b64uDecode(notary.chain_pubkey, 64);

let chain: ReturnType<typeof createSimChain>;
let verifier: CardVerifier;

function rpc(c: typeof chain) {
  const entry = (address: string) => {
    const x = c.card(address);
    return x ? { log_head_cid: x.head_cid, policy_address: c.policyCards.get(x.policy) ?? x.policy, last_press_address: x.press, forward_to: null, exists: true } : null;
  };
  return {
    getCardEntry: async (a: string) => entry(a),
    isPolicyAuthorizer: async (a: string) => [...c.policyCards.values()].includes(a),
    getPressAuthorization: async (policy: string, press: string) => { const p = c.pressAuth(policy, press); return p ? { press_public_key: p.press_public_key, mldsa44_key_hash: "", active: p.active, authorized_at: "2027-01-01T00:00:00Z", revoked_at: null } : null; },
    getSubCardEntry: async () => null,
    getCardEventLog: async (a: string) => (c.card(a)?.events ?? []).map((e: { cid: string; timestamp: string }) => ({ cid: e.cid, timestamp: e.timestamp })),
    getEasAnnotations: async () => [],
  };
}

beforeAll(() => {
  chain = createSimChain({ blockMs: 3_600_000 });
  for (const [cid, b] of Object.entries(fx.ipfs as Record<string, string>)) chain.ipfs.set(cid, b64uDecode(b));
  // the template policy T: a card of its own, registered in PolicyAuthorizerKeys (the chain walk ends there)
  const tHead = chain.pin(seal(tpub, { ancestry_pubkeys: [], policy_id: fx.template_policy_id, recipient_pubkey: fx.template_pubkey }));
  chain.registerCard({ address: T_ADDR, policy: "root", press: "00".repeat(32), head_cid: tHead });
  chain.policyCards.set(fx.template_policy_id, T_ADDR);
  // the notary card as the policy holder issued it (lifecycle step 7): the countersigned offer plus the E17 fields
  const requestCid = chain.pin(canonicalNotary(notary.request));
  const attCid = chain.pin(b64uDecode(notary.attestation));
  expect(attCid).toBe(notary.offer.genesis_attestation);
  const card = { ...notary.offer, genesis_request: requestCid, operator_host_pubkey: notary.request.operator_host_pubkey, issued_at: new Date(fx.now_ms + 1000).toISOString(), ancestry_pubkeys: [fx.template_pubkey] };
  chain.registerCard({ address: fx.notary_card, policy: "notary-card-policy", press: "11".repeat(32), head_cid: chain.pin(seal(kid, card)) });
  // AuthorizePress(T, notary card, chain_pubkey): the simulated registry's entry, created in test setup
  chain.authorizePress(T_ADDR, fx.notary_card, chainKey);
  verifier = new CardVerifier({ rpc: rpc(chain) as never, ipfs: { fetch: async (cid: string) => { const b = chain.ipfs.get(cid); if (!b) throw new Error(`no ${cid}`); return b; } }, trustedRoots: [] });
});

describe("the simulated registry's write gate (registry_contract §4.1, §6.1)", () => {
  it("refuses what step 8 and the press checks refuse, then registers the broker's payloads in order", () => {
    const [first, ...rest] = fx.submissions;
    const gate = (m: unknown) => chain.submitTx(m as never);
    // a host that changes any calldata field is refused (E-49), as is a bad signature, and nothing is consumed
    for (const f of ["card_address", "initial_log_cid", "policy_address", "press_address"]) {
      const forged = { ...first, calldata: { ...first.calldata, [f]: b64uEncode(new Uint8Array(f === "initial_log_cid" ? 59 : 32).fill(9)) } };
      expect(gate(forged), f).toEqual({ failed: expect.stringMatching(/PAYLOAD_CALLDATA_MISMATCH|PRESS_NOT_AUTHORIZED/) });
    }
    expect(gate({ ...first, signature: b64uEncode(new Uint8Array(64).fill(1)) })).toEqual({ failed: "PRESS_SIGNATURE_INVALID" });
    expect(gate({ ...first, payload: { ...first.payload, card_address: first.calldata.card_address.replace(/^./, "A") }, calldata: { ...first.calldata, card_address: first.calldata.card_address.replace(/^./, "A") } })).toEqual({ failed: "PRESS_SIGNATURE_INVALID" });
    expect(gate(rest[0])).toEqual({ failed: "SEQUENCE_MISMATCH" });
    expect(chain.pressAuth(T_ADDR, fx.notary_card)!.next_sequence).toBe(0);
    for (const m of fx.submissions) expect(gate(m), "tx_hash").toHaveProperty("tx_hash");
    expect(chain.pressAuth(T_ADDR, fx.notary_card)!.next_sequence).toBe(4);
    expect(gate(first)).toEqual({ failed: "SEQUENCE_MISMATCH" });
  });
});

describe("derived cards pass standard verification over the simulated chain", () => {
  for (let i = 0; i < 4; i++) {
    it(`card ${i}: Stages 1-6 and Stage 5 step 3a`, async () => {
      const h = fx.holders[i];
      const dpub = b64uDecode(h.pubkey, 1312);
      const address = hex(keccak_256(dpub));
      const entry = chain.card(address)!;
      expect(entry, "registered under keccak256(D)").toBeTruthy();
      const doc = open(dpub, chain.ipfs.get(entry.head_cid)!);
      expect(doc).toMatchObject({ policy_id: fx.template_policy_id, issuer_card: fx.notary_card, press_card: fx.notary_card, source_policy: fx.source_policy, projected: '{"level":"gold"}', protocol_version: "0.1" });
      expect(doc.ancestry_pubkeys).toEqual([notary.id_pubkey, fx.template_pubkey]);
      // standard verification, Stages 3, 4 and 6 by address and key (CardVerifier.verifyCard)
      const r = await verifier.verifyCard(address, { pubkey: h.pubkey });
      expect(r.errors).toEqual([]);
      expect(r.chain_reaches_trusted_root).toBe(true);
      expect(r.chain_card_addresses).toEqual([address, fx.notary_card, T_ADDR]);
      expect(r.revocation.status).toBe("not_revoked");
      expect(r.is_currently_valid).toBe(true);
      // Stage 5: the policy, the press authorization of the notary under T, and step 3a through the hook
      const notaryDoc = open(kid, chain.ipfs.get(chain.card(fx.notary_card)!.head_cid)!);
      const events = chain.card(address)!.events;
      const cfg = {
        derived: doc, notaryCard: notaryDoc, notaryCardPointer: fx.notary_card, templateKey: fx.template_pubkey, notaryPolicyId: notary.request.policy_id,
        templateNotary: { derived_card: { source_kind: "card" } } as never, registeredAtMs: Date.parse(events[0].timestamp), nowMs: fx.now_ms + 3_600_000,
        cfg: { roots: { simulator: b64uDecode(fx.trust_root) }, allowSimulator: true },
        modules: [simulator],
        acceptedRuntimes: [{ accepted_from: "2026-01-01T00:00:00Z", build_recipe_cid: "x", close_compat: "c1", pcr0: fx.pcr0, platform: "simulator", source_commit: "s", version: "1" }],
        reads: { fetch: async (c: string) => chain.ipfs.get(c) ?? null, operatorCardValid: async () => true, keyExposure: async () => "none" as const },
      };
      const n = await verifyNotaryIssuedCard(cfg);
      expect(n, JSON.stringify(n)).toMatchObject({ ok: true });
      const entryDoc = rpc(chain).getCardEntry as (a: string) => Promise<unknown>;
      const s5 = await verifyStage5(doc, (await entryDoc(address)) as never, address, entry.head_cid, chain.ipfs.get(entry.head_cid)!, rpc(chain) as never, { fetch: async (c: string) => chain.ipfs.get(c)! }, {}, async () => n);
      expect(s5.errors).toEqual([]);
      expect(s5.policy_compliant).toBe(true);
      expect(s5.press_subsequently_revoked).toBe(false);
      expect(s5.notary?.derived["dup_tag"]).toBe(doc.dup_tag);
    });
  }
  it("all four cards carry distinct tags, one expiry and one issued_at (nothing tells holders apart)", () => {
    const docs = fx.holders.map((h: { pubkey: string }) => { const p = b64uDecode(h.pubkey, 1312); return open(p, chain.ipfs.get(chain.card(hex(keccak_256(p)))!.head_cid)!); });
    expect(new Set(docs.map((d: { dup_tag: string }) => d.dup_tag)).size).toBe(4);
    expect(new Set(docs.map((d: { expires_at: string }) => d.expires_at)).size).toBe(1);
    expect(new Set(docs.map((d: { issued_at: string }) => d.issued_at)).size).toBe(1);
  });
  it("a card whose notary has no AuthorizePress entry under T fails Stage 5", async () => {
    const c2 = createSimChain({ blockMs: 3_600_000 });
    for (const [cid, b] of chain.ipfs) c2.ipfs.set(cid, b);
    for (const e of chain.events) c2.registerCard({ address: e.cardAddress, policy: e.policyAddress, press: e.pressAddress, head_cid: e.headCid });
    for (const [k, v] of chain.policyCards) c2.policyCards.set(k, v);
    const h = fx.holders[0];
    const dpub = b64uDecode(h.pubkey, 1312);
    const address = hex(keccak_256(dpub));
    const entry = c2.card(address)!;
    const doc = open(dpub, c2.ipfs.get(entry.head_cid)!);
    const s5 = await verifyStage5(doc, (await rpc(c2).getCardEntry(address)) as never, address, entry.head_cid, c2.ipfs.get(entry.head_cid)!, rpc(c2) as never, { fetch: async (c: string) => c2.ipfs.get(c)! }, { registryEndpoint: "http://127.0.0.1:9" });
    expect(s5.policy_compliant).toBe(false);
  });
});

void cidOfBytes;
