import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { b64uDecode, canonicalNotary, cardPointer, cidOfBytes, verifyNotaryIssuedCard } from "@membership-card-protocol/verifier/notary";
import type { AcceptedRuntime, GenesisRequest, NotaryIssuedInput } from "@membership-card-protocol/verifier/notary";
import { simulator, awsNitroEnclaves } from "../src/index.ts";

const VEC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "vectors");
const load = (f: string) => JSON.parse(readFileSync(join(VEC, f), "utf8"));
const fx = load("attestation/genesis_attestations.json");
const request = { ...load("objects/genesis_request.json").cases[0].input, platform: "simulator" } as GenesisRequest; // the fixtures bind H(this request)
const NOTARY_PTR = cardPointer(b64uDecode(request.id_pubkey, 1312));
const TEMPLATE_KEY = "TEMPLATE_KEY_B64U";
const NOTARY_POLICY = "bafkreinotarypolicy";
const store = new Map<string, Uint8Array>();
const put = (b: Uint8Array) => { const c = cidOfBytes(b); store.set(c, b); return c; };
const reqCid = put(canonicalNotary(request));
const attCid = (name: string) => put(b64uDecode(fx.docs[name]));
const accepted: AcceptedRuntime[] = [{ accepted_from: "2026-01-01T00:00:00Z", build_recipe_cid: "x", close_compat: "c", pcr0: fx.accepted_pcr0, platform: "simulator", source_commit: "s", version: "1" }];

const card = (over: object = {}, att = "good") => ({
  chain_pubkey: request.chain_pubkey, genesis_attestation: attCid(att), genesis_request: reqCid, issuer_card: "ee".repeat(32), operator_card: request.operator_card,
  operator_host_pubkey: request.operator_host_pubkey, platform: "simulator" as const, policy_id: "bafkreicardpolicy", recipient_pubkey: request.id_pubkey, issued_at: "2026-11-12T10:00:00Z", ...over,
});
const input = (o: Partial<NotaryIssuedInput> = {}, cardOver: object = {}, att = "good"): NotaryIssuedInput => ({
  derived: { issuer_card: NOTARY_PTR, press_card: NOTARY_PTR, ancestry_pubkeys: [request.id_pubkey, TEMPLATE_KEY], expires_at: "2026-11-19T00:00:00Z", source_policy: "bafkreisource", projected: "{\"a\":1}", dup_tag: "TAG" },
  notaryCard: card(cardOver, att), notaryCardPointer: NOTARY_PTR, templateKey: TEMPLATE_KEY, notaryPolicyId: request.policy_id, templateNotary: {}, registeredAtMs: Date.parse("2026-11-13T00:00:00Z"),
  nowMs: fx.now_ms + 3600_000, cfg: { roots: { simulator: b64uDecode(fx.trust_root) }, allowSimulator: true }, modules: [simulator, awsNitroEnclaves], acceptedRuntimes: accepted,
  reads: { fetch: async (c) => store.get(c) ?? null, operatorCardValid: async () => true, keyExposure: async () => "none" }, ...o,
});
const code = async (i: NotaryIssuedInput) => { const r = await verifyNotaryIssuedCard(i); return r.ok ? "ok" : r.code; };

describe("algorithm G for later verifiers: the genesis request comes from the card's genesis_request CID (E17)", () => {
  it("accepts a derived card from a genuine notary and returns dup_tag without checking it", async () => {
    const r = await verifyNotaryIssuedCard(input());
    expect(r).toMatchObject({ ok: true, warnings: [], derived: { dup_tag: "TAG", source_policy: "bafkreisource", expires_at: "2026-11-19T00:00:00Z" } });
  });
  it("NOTARY_GENESIS_INVALID: attestation made for a different request, a debug enclave, an unaccepted runtime", async () => {
    expect(await code(input({}, {}, "wrong_nonce"))).toBe("NOTARY_GENESIS_INVALID");
    expect(await code(input({}, {}, "debug"))).toBe("NOTARY_GENESIS_INVALID");
    expect(await code(input({}, {}, "other_pcr0"))).toBe("NOTARY_GENESIS_INVALID");
  });
  it("NOTARY_GENESIS_INVALID: the card's fields differ from the request the attestation covers (the replay E17 exists to stop)", async () => {
    expect(await code(input({}, { operator_host_pubkey: request.id_pubkey }))).toBe("NOTARY_GENESIS_INVALID"); // someone else's host key
    expect(await code(input({}, { operator_card: "00".repeat(32) }))).toBe("NOTARY_GENESIS_INVALID");
    expect(await code(input({}, { chain_pubkey: request.id_pubkey }))).toBe("NOTARY_GENESIS_INVALID");
    expect(await code(input({}, { platform: "aws-nitro-enclaves" }))).toBe("NOTARY_GENESIS_INVALID");
    expect(await code(input({ notaryPolicyId: "bafkreiother" }))).toBe("NOTARY_GENESIS_INVALID");
  });
  it("NOTARY_GENESIS_INVALID: request or attestation unavailable, or not matching their CIDs", async () => {
    expect(await code(input({}, { genesis_request: "bafkreiaaaa" }))).toBe("NOTARY_GENESIS_INVALID");
    expect(await code(input({ reads: { ...input().reads, fetch: async (c) => (c === reqCid ? canonicalNotary({ ...request, nonce: "AAAAAAAAAAAAAAAAAAAAAA" }) : store.get(c) ?? null) } }))).toBe("NOTARY_GENESIS_INVALID");
    expect(await code(input({ reads: { ...input().reads, fetch: async () => null } }))).toBe("NOTARY_GENESIS_INVALID");
  });
  it("NOTARY_GENESIS_INVALID when the operator card is revoked, or the simulator is not enabled", async () => {
    expect(await code(input({ reads: { ...input().reads, operatorCardValid: async () => false } }))).toBe("NOTARY_GENESIS_INVALID");
    expect(await code(input({ cfg: { roots: { simulator: b64uDecode(fx.trust_root) }, allowSimulator: false } }))).toBe("NOTARY_GENESIS_INVALID");
  });
  it("t_eval is the notary card's issued_at with no max_age: an old genesis attestation is fine", async () => {
    expect(await code(input({ nowMs: fx.now_ms + 900 * 86_400_000 }))).toBe("ok");
  });
});

describe("Stage 5 step 3a shape, exposure and source kind", () => {
  it("NOTARY_DERIVED_SHAPE: issuer or press is not the notary card; wrong ancestry", async () => {
    const d = input().derived;
    expect(await code(input({ derived: { ...d, issuer_card: "ff".repeat(32) } }))).toBe("NOTARY_DERIVED_SHAPE");
    expect(await code(input({ derived: { ...d, press_card: "ff".repeat(32), issuer_card: "ff".repeat(32) } }))).toBe("NOTARY_DERIVED_SHAPE");
    expect(await code(input({ derived: { ...d, ancestry_pubkeys: [TEMPLATE_KEY, request.id_pubkey] } }))).toBe("NOTARY_DERIVED_SHAPE");
    expect(await code(input({ derived: { ...d, ancestry_pubkeys: [request.id_pubkey] } }))).toBe("NOTARY_DERIVED_SHAPE");
  });
  it("algorithm E at the CardRegistered time: exposed, later (warning), lineage incomplete; queried for the notary card at that time", async () => {
    expect(await code(input({ reads: { ...input().reads, keyExposure: async () => "exposed" } }))).toBe("NOTARY_KEY_EXPOSED");
    expect(await code(input({ reads: { ...input().reads, keyExposure: async () => "lineage_incomplete" } }))).toBe("NOTARY_LINEAGE_INCOMPLETE");
    const later = await verifyNotaryIssuedCard(input({ reads: { ...input().reads, keyExposure: async () => "later" } }));
    expect(later).toMatchObject({ ok: true, warnings: ["notary_key_exposed_later"] });
    let asked: [string, number] | undefined;
    await verifyNotaryIssuedCard(input({ reads: { ...input().reads, keyExposure: async (p, t) => { asked = [p, t]; return "none"; } } }));
    expect(asked).toEqual([NOTARY_PTR, Date.parse("2026-11-13T00:00:00Z")]);
  });
  it("source_kind other than card (e.g. the reserved web_evidence) is NOTARY_DERIVED_SHAPE; absent or card is fine", async () => {
    expect(await code(input({ templateNotary: { derived_card: { source_kind: "web_evidence" } } }))).toBe("NOTARY_DERIVED_SHAPE");
    expect(await code(input({ templateNotary: { derived_card: { source_kind: "card" } } }))).toBe("ok");
  });
  it("the checks run in the spec's order: genesis before shape before exposure before source kind", async () => {
    const bad = { reads: { ...input().reads, keyExposure: async () => "exposed" as const }, templateNotary: { derived_card: { source_kind: "x" } }, derived: { ...input().derived, issuer_card: "ff".repeat(32) } };
    expect(await code(input(bad, {}, "debug"))).toBe("NOTARY_GENESIS_INVALID");
    expect(await code(input(bad))).toBe("NOTARY_DERIVED_SHAPE");
    expect(await code(input({ ...bad, derived: input().derived }))).toBe("NOTARY_KEY_EXPOSED");
  });
});
