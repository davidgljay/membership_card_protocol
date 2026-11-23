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
import { approval, members } from "../src/world.ts";
import { notaryStage5Hook } from "@membership-card-protocol/verifier/notary";
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
    getGovernanceKeyset: async () => ({ keys: members.map((m) => m.xy), quorum: 4, version: 1, key_scheme: 0 as const }),
    getNotaryLogAnchors: async () => [], // the fixture has no EAS anchors: algorithm E must fail closed
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

// ---- Stage 5 step 3a through CardVerifier (F5): the hook is injected, the result carries `notary` ----------------------

describe("CardVerifier Stage 5 step 3a (card_verifier.md §7.5; F4a): the notary hook's reads over the simulated chain", () => {
  const listKey = (name: string) => { const k = ml_dsa44.keygen(new Uint8Array(32).fill(name.charCodeAt(0))); return { ...k, addr: hex(keccak_256(k.publicKey)), b64: b64uEncode(k.publicKey) }; };
  const RT = listKey("r"), PR = listKey("p");
  const runtimes = [{ accepted_from: "2026-01-01T00:00:00Z", build_recipe_cid: "x", close_compat: "c1", pcr0: fx.pcr0, platform: "simulator", source_commit: "s", version: "1" }];
  const programs = [{ accepted_from: "2026-01-01T00:00:00Z", audit_report_cid: "x", name: "derive", program_cid: "bafkreiprogram", source_commit: "s", toolchain: "rust", version: "1" }];
  let c2: ReturnType<typeof createSimChain>;
  const verOn = (c: ReturnType<typeof createSimChain>, notary?: Record<string, unknown>) => new CardVerifier({ rpc: rpc(c) as never, ipfs: { fetch: async (cid: string) => { const b = c.ipfs.get(cid); if (!b) throw new Error(`no ${cid}`); return b; } }, trustedRoots: [], ...(notary ? { notary: notary as never } : {}) });
  const cfg = (over: Record<string, unknown> = {}) => {
    const base = { attestation: [simulator], attestationRoots: { simulator: b64uDecode(fx.trust_root) }, allowSimulator: true, acceptedRuntimesCard: RT.addr, programAllowlistCard: PR.addr,
      acceptedRuntimesCardPubkey: RT.b64, programAllowlistCardPubkey: PR.b64, notaryCardPolicy: notary.offer.policy_id, ...over };
    return { ...base, stage5Hook: notaryStage5Hook(base as never) };
  };
  beforeAll(async () => {
    c2 = createSimChain({ blockMs: 3_600_000 });
    for (const [cid, b] of chain.ipfs) c2.ipfs.set(cid, b);
    for (const e of chain.events) c2.registerCard({ address: e.cardAddress, policy: e.policyAddress, press: e.pressAddress, head_cid: e.headCid });
    for (const [k, v] of chain.policyCards) c2.policyCards.set(k, v);
    c2.authorizePress(T_ADDR, fx.notary_card, chainKey);
    for (const [k, list, value] of [[RT, "accepted_runtimes", runtimes], [PR, "program_allowlist", programs]] as const) {
      const doc = { [list]: value, ancestry_pubkeys: [fx.template_pubkey], issued_at: "2026-01-01T00:00:00Z", list_approval: approval(list, k.addr, value), policy_id: fx.template_policy_id, recipient_pubkey: k.b64 };
      c2.registerCard({ address: k.addr, policy: "lists-policy", press: "22".repeat(32), head_cid: c2.pin(seal(k.publicKey, doc)) });
    }
  });
  it("an operator card that is not registered fails algorithm G (NOT_OPERATOR_INVALID), before algorithm E", async () => {
    const r = await verifyViaHook(cfg());
    expect(r, JSON.stringify(r)).toMatchObject({ ok: false, code: "NOTARY_GENESIS_INVALID", detail: "algorithm G: NOT_OPERATOR_INVALID" });
  });
  it("the real hook reads the lists, the notary card, algorithm G and the template, then fails closed at algorithm E (this fixture has no identity-log anchors)", async () => {
    // the failure is the lineage, so everything before algorithm E passed: lists (L, Stages 3-5 on the list cards), G, shape
    c2.registerCard({ address: notary.offer.operator_card, policy: "operators", press: "33".repeat(32), head_cid: c2.pin(new TextEncoder().encode("{}")) });
    const r = await verifyViaHook(cfg());
    expect(r, JSON.stringify(r)).toMatchObject({ ok: false, code: "NOTARY_LINEAGE_INCOMPLETE" });
  });
  const verifyViaHook = async (n: ReturnType<typeof cfg>, c = c2) => {
    const h = fx.holders[0], dpub = b64uDecode(h.pubkey, 1312), address = hex(keccak_256(dpub));
    const v = verOn(c, n);
    return n.stage5Hook({ cardDoc: open(dpub, c.ipfs.get(c.card(address)!.head_cid)!), cardAddress: address, rpc: rpc(c) as never, ipfs: { fetch: async (cid: string) => c.ipfs.get(cid)! }, nowMs: Date.now(),
      listCardTrusted: async (a, pub) => { const r = await v.verifyCard(a, { pubkey: b64uEncode(pub) }); return r.errors.length === 0 && r.chain_reaches_trusted_root === true; } });
  };
  // E11 (F7.1): the notary policy named by the genesis request must carry the key behind the notary card's issuer_card.
  const withNotaryCard = (change: (card: Record<string, unknown>) => Record<string, unknown>) => {
    const c3 = createSimChain({ blockMs: 3_600_000 });
    for (const [cid, b] of c2.ipfs) c3.ipfs.set(cid, b);
    for (const e of c2.events) {
      const head = e.cardAddress === fx.notary_card ? c3.pin(seal(kid, change(open(kid, c2.ipfs.get(e.headCid)!)))) : e.headCid;
      c3.registerCard({ address: e.cardAddress, policy: e.policyAddress, press: e.pressAddress, head_cid: head });
    }
    for (const [k, v] of c2.policyCards) c3.policyCards.set(k, v);
    c3.authorizePress(T_ADDR, fx.notary_card, chainKey);
    return c3;
  };
  it("refuses a notary card whose issuer_card is not the card behind the notary policy it serves", async () => {
    const r = await verifyViaHook(cfg(), withNotaryCard((c) => ({ ...c, issuer_card: "dd".repeat(32) })));
    expect(r, JSON.stringify(r)).toMatchObject({ ok: false, code: "NOTARY_GENESIS_INVALID", detail: expect.stringMatching(/issuer_card/) });
  });
  it("accepts the same chain when the card is left as issued (negative control)", async () => {
    const r = await verifyViaHook(cfg(), withNotaryCard((c) => c));
    expect(r, JSON.stringify(r)).toMatchObject({ ok: false, code: "NOTARY_LINEAGE_INCOMPLETE" });
  });
  // Each way the lists can fail is refused before any card is judged (negative controls: the honest config above got to algorithm E).
  it("refuses a pinned list-card key that does not hash to the address, a list-card key of the wrong card, and a list card that fails Stages 3-5", async () => {
    expect(await verifyViaHook(cfg({ acceptedRuntimesCardPubkey: PR.b64 }))).toMatchObject({ ok: false, code: "NOTARY_CONFIG_MISSING" });
    expect(await verifyViaHook(cfg({ programAllowlistCard: "ab".repeat(32) }))).toMatchObject({ ok: false, code: "NOTARY_CONFIG_MISSING" });
    // a list card whose chain does not reach a policy authorizer
    const lone = listKey("z");
    const doc = { accepted_runtimes: runtimes, ancestry_pubkeys: [], issued_at: "2026-01-01T00:00:00Z", list_approval: approval("accepted_runtimes", lone.addr, runtimes), policy_id: fx.template_policy_id, recipient_pubkey: lone.b64 };
    c2.registerCard({ address: lone.addr, policy: "lists-policy", press: "22".repeat(32), head_cid: c2.pin(seal(lone.publicKey, doc)) });
    expect(await verifyViaHook(cfg({ acceptedRuntimesCard: lone.addr, acceptedRuntimesCardPubkey: lone.b64 }))).toMatchObject({ ok: false, code: "LIST_CARD_UNTRUSTED" });
  });
  it("refuses a list version whose governance approval is missing quorum", async () => {
    const weak = listKey("w");
    const a = JSON.parse(approval("accepted_runtimes", weak.addr, runtimes)); a.signatures = a.signatures.slice(0, 2);
    const doc = { accepted_runtimes: runtimes, ancestry_pubkeys: [fx.template_pubkey], issued_at: "2026-01-01T00:00:00Z", list_approval: new TextDecoder().decode(canonicalNotary(a)), policy_id: fx.template_policy_id, recipient_pubkey: weak.b64 };
    c2.registerCard({ address: weak.addr, policy: "lists-policy", press: "22".repeat(32), head_cid: c2.pin(seal(weak.publicKey, doc)) });
    expect(await verifyViaHook(cfg({ acceptedRuntimesCard: weak.addr, acceptedRuntimesCardPubkey: weak.b64 }))).toMatchObject({ ok: false, code: "LIST_APPROVAL_THRESHOLD" });
  });
  it("a card that is not derived-shaped is not judged (null), with or without a hook", async () => {
    const h = fx.holders[0], dpub = b64uDecode(h.pubkey, 1312), address = hex(keccak_256(dpub));
    const doc = { ...open(dpub, c2.ipfs.get(c2.card(address)!.head_cid)!), dup_tag: undefined };
    const n = cfg();
    expect(await n.stage5Hook({ cardDoc: doc, cardAddress: address, rpc: rpc(c2) as never, ipfs: { fetch: async () => new Uint8Array() }, nowMs: Date.now(), listCardTrusted: async () => true })).toBeNull();
  });
});

void cidOfBytes;
