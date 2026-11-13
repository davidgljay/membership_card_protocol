/**
 * The end-to-end world (step 5.5): every key is derived from a fixed seed, so the runtime's pins file
 * (`fixtures/pins.json`) can be written before anything runs, and the cards are registered on the simulated chain by
 * the driver. Card shapes follow the conformance worlds (`verifier/scripts/gen-notary-conformance.ts`): AES-256-GCM
 * documents under the card content key, ancestry to a pinned trusted root, a `notary_input` signing sub-card.
 *
 *   node --experimental-strip-types src/world.ts --pins fixtures/pins.json --root <base64url test root DER>
 */
import { createCipheriv } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import { keccak_256, sha3_256 } from "@noble/hashes/sha3";
import { hkdf } from "@noble/hashes/hkdf";
import { canonicalize } from "@membership-card-protocol/verifier";
import { H, b64uEncode, b64uDecode, canonicalNotary, cidOfBytes, withoutFields } from "@membership-card-protocol/verifier/notary";

const te = new TextEncoder();
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
export const ISSUED_AT = "2026-01-01T00:00:00.000Z";
export const FIXTURES = new URL("../fixtures/", import.meta.url);

export type Key = { name: string; pub: Uint8Array; sec: Uint8Array; b64: string; addr: string };
const cache = new Map<string, Key>();
export function key(name: string): Key {
  let k = cache.get(name);
  if (!k) {
    const kp = ml_dsa44.keygen(sha256(te.encode(`card-notary-e2e-key-${name}`)));
    k = { name, pub: kp.publicKey, sec: kp.secretKey, b64: b64uEncode(kp.publicKey), addr: hex(keccak_256(kp.publicKey)) };
    cache.set(name, k);
  }
  return k;
}
export const signBytes = (k: Key, msg: Uint8Array) => b64uEncode(ml_dsa44.sign(msg, k.sec, { extraEntropy: false }));

/** Governance members: P-256 (scheme 0), 4 of 5. */
export const members = [0, 1, 2, 3, 4].map((i) => {
  const sk = sha256(te.encode(`card-notary-e2e-member-${i}`));
  return { sk, xy: p256.getPublicKey(sk, false).subarray(1) };
});

export const contentKey = (pub: Uint8Array) => hkdf(sha3_256, pub, undefined, te.encode("card-content-v1"), 32);
export function encrypt(forPub: Uint8Array, obj: unknown, nonceSeed: string): Uint8Array {
  const nonce = sha256(te.encode(`e2e-nonce-${nonceSeed}`)).subarray(0, 12);
  const c = createCipheriv("aes-256-gcm", contentKey(forPub), nonce);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj))), c.final()]);
  return new Uint8Array(Buffer.concat([nonce, ct, c.getAuthTag()]));
}

/** What the world needs from the chain: the simulated chain over HTTP, or in-process. */
export interface ChainWrites {
  pin(bytes: Uint8Array): Promise<string>;
  registerCard(c: { address: string; policy: string; press: string; head_cid: string }): Promise<unknown>;
  registerSub(s: { master_card: string; sub_card: string; sub_card_doc_cid: string; active: boolean }): Promise<unknown>;
}

export function httpChain(base: string): ChainWrites & { get<T>(path: string): Promise<T>; bytes(cid: string): Promise<Uint8Array | null> } {
  const post = async (path: string, body: unknown) => (await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  return {
    async pin(bytes) { const r = await fetch(`${base}/ipfs`, { method: "PUT", body: bytes }); return ((await r.json()) as { cid: string }).cid; },
    registerCard: (c) => post("/registry/card", c),
    registerSub: (s) => post("/registry/subcard", s),
    async get<T>(path: string) { const r = await fetch(`${base}${path}`); if (!r.ok) throw new Error(`${path}: ${r.status}`); return (await r.json()) as T; },
    async bytes(cid: string) { const r = await fetch(`${base}/ipfs/${cid}`); return r.ok ? new Uint8Array(await r.arrayBuffer()) : null; },
  };
}

// ---- fixed identities ---------------------------------------------------------------------------------------------

export const K = {
  root: key("root"), appRoot: key("app-root"), loginRoot: key("login-root"),
  chapter: key("chapter"), app: key("app"), policy: key("policy"), requester: key("requester"), operator: key("operator"),
  listRuntimes: key("list-runtimes"), listPrograms: key("list-programs"), listHolder: key("list-holder"), press: key("press"),
  host: key("host"),
};
export const contributor = (i: number) => ({ card: key(`member-${i}`), sub: key(`member-${i}-sub`) });

export const PROGRAM = new Uint8Array(readFileSync(new URL("tally.wasm", FIXTURES)));
export const PROGRAM_CID = cidOfBytes(PROGRAM);
export const SIM_PCR0 = b64uEncode(new Uint8Array(48).fill(0x42));
const marker = (name: string) => canonicalNotary({ e2e: name, type: "e2e.policy_marker" });
/** Template and policy identifiers: CIDs of small pinned marker documents. */
export const IDS = {
  rootPolicy: cidOfBytes(marker("root-policy")), sourcePolicy: cidOfBytes(marker("source-policy")), appsPolicy: cidOfBytes(marker("apps")),
  metaPolicy: cidOfBytes(marker("meta-policy")), notaryCardPolicy: cidOfBytes(marker("notary-card-policy")), listsPolicy: cidOfBytes(marker("lists")),
};
export const PRESS_ADDR = "0x" + "11".repeat(20);

export const OUTPUT_SCHEMA = [{ name: "no", type: "integer", required: true, clamp: [0, 1000000] }, { name: "yes", type: "integer", required: true, clamp: [0, 1000000] }];
export const NOTARY_SECTION = {
  contributor_predicate: { issued_under_template: IDS.sourcePolicy }, input_replacement: "latest_wins",
  input_schema: [{ name: "choice", type: "text", required: true, enum: ["yes", "no"] }],
  isolation: "dedicated", mode: "aggregate", output_action: "statement", output_recipients: { cards: [], job_requester: false, public: true },
  output_schema: OUTPUT_SCHEMA, platform: "simulator", privacy: { k_min: 2 }, program_cid: PROGRAM_CID, retention: "none",
};

const card = (k: Key, policy: string, ancestry: string[], extra: Record<string, unknown> = {}) => ({
  ancestry_pubkeys: ancestry, holder_signature: "h", issued_at: ISSUED_AT, issuer_card: "x", issuer_signature: "i",
  policy_id: policy, press_card: "p", press_signature: "s", protocol_version: "0.1", recipient_pubkey: k.b64, ...extra,
});

export const policyGenesis = { ancestry_pubkeys: [K.root.b64], approved_notaries: [] as string[], issued_at: ISSUED_AT, issuer_card: "x", notary: NOTARY_SECTION,
  policy_id: IDS.metaPolicy, recipient_pubkey: K.policy.b64 };
/** The job's `policy_id`: the plain policy document (card_verifier §7.5, lifecycle A.7 R1). */
export const POLICY_ID = cidOfBytes(canonicalNotary(policyGenesis));

// ---- governance lists (§34) ---------------------------------------------------------------------------------------

export const RUNTIMES = [{ accepted_from: "2026-01-01T00:00:00Z", build_recipe_cid: IDS.listsPolicy, close_compat: "c1", pcr0: SIM_PCR0, platform: "simulator", source_commit: "e2e", version: "1" }];
export const PROGRAMS = [{ accepted_from: "2026-01-01T00:00:00Z", audit_report_cid: IDS.listsPolicy, name: "tally", program_cid: PROGRAM_CID, source_commit: "e2e", toolchain: "wat", version: "1" }];

function approval(list: string, cardAddr: string, value: unknown): string {
  const a: Record<string, unknown> = { governance_version: 1, kind: "standard", list, list_card: cardAddr, list_hash: H(value), list_version: 1, signatures: [], type: "notary_list_approval" };
  const digest = b64uDecode(H(withoutFields(a, "signatures")), 32);
  a["signatures"] = [0, 1, 2, 3].map((i) => ({ key_index: i, signature: b64uEncode(p256.sign(digest, members[i]!.sk, { prehash: false, lowS: false }).toCompactRawBytes()) }));
  return new TextDecoder().decode(canonicalNotary(a));
}

function listGenesis(k: Key, field: string, value: unknown) {
  const doc: Record<string, unknown> = { [field]: value, list_approval: approval(field, k.addr, value), policy_id: IDS.listsPolicy, recipient_pubkey: k.b64 };
  doc["press_signature"] = signBytes(K.press, canonicalize(doc));
  return doc;
}

// ---- pins (runtime §12, E29) --------------------------------------------------------------------------------------

export function pins(attestationRootB64: string) {
  return {
    accepted_runtimes_card: K.listRuntimes.addr, accepted_runtimes_card_key: K.listRuntimes.b64,
    program_allowlist_card: K.listPrograms.addr, program_allowlist_card_key: K.listPrograms.b64,
    accepted_runtimes_floor: 1, program_allowlist_floor: 1,
    keyset: { keys: members.map((m) => b64uEncode(m.xy)), quorum: 4, version: 1, key_scheme: 0 },
    list_holder_key: K.listHolder.b64, list_press_key: K.press.b64,
    attestation_root: attestationRootB64,
    trusted_roots: [K.root.addr], app_certification_root: K.appRoot.addr, login_service_root: K.loginRoot.addr, max_chain_depth: 64,
  };
}

// ---- registration -------------------------------------------------------------------------------------------------

/** Registers everything that doesn't depend on the notary's genesis. Returns the CIDs the driver needs later. */
export async function registerWorld(c: ChainWrites, nContributors: number) {
  for (const n of ["root-policy", "source-policy", "apps", "meta-policy", "notary-card-policy", "lists"]) await c.pin(marker(n));
  await c.pin(PROGRAM);
  const reg = async (k: Key, policy: string, doc: unknown, seed: string) => {
    const head = await c.pin(encrypt(k.pub, doc, seed));
    await c.registerCard({ address: k.addr, policy, press: PRESS_ADDR, head_cid: head });
    return head;
  };
  // governance list cards
  await reg(K.listRuntimes, IDS.listsPolicy, listGenesis(K.listRuntimes, "accepted_runtimes", RUNTIMES), "list-runtimes");
  await reg(K.listPrograms, IDS.listsPolicy, listGenesis(K.listPrograms, "program_allowlist", PROGRAMS), "list-programs");
  // the chapter, the app, the requester and the operator
  await reg(K.chapter, IDS.rootPolicy, card(K.chapter, IDS.rootPolicy, [K.root.b64], { tier: "chapter" }), "chapter");
  await reg(K.app, IDS.appsPolicy, card(K.app, IDS.appsPolicy, [K.appRoot.b64]), "app");
  await reg(K.requester, IDS.sourcePolicy, card(K.requester, IDS.sourcePolicy, [K.chapter.b64, K.root.b64], { role: "organizer" }), "requester");
  await reg(K.operator, IDS.sourcePolicy, card(K.operator, IDS.sourcePolicy, [K.chapter.b64, K.root.b64], { role: "operator" }), "operator");
  // the policy: plain document at policy_id, encrypted genesis in the registry
  await c.pin(canonicalNotary(policyGenesis));
  const policyGenesisCid = await reg(K.policy, IDS.metaPolicy, policyGenesis, "policy-genesis");
  // contributors, each with a notary_input signing sub-card
  for (let i = 0; i < nContributors; i++) {
    const { card: m, sub: s } = contributor(i);
    await reg(m, IDS.sourcePolicy, card(m, IDS.sourcePolicy, [K.chapter.b64, K.root.b64], { active_subcards: [s.b64], member_level: "gold" }), `member-${i}`);
    const unsigned = { app_card: K.app.addr, app_card_pubkey: K.app.b64, attestation_level: "T2", capabilities: ["notary_input"], holder_primary_card: m.addr,
      holder_primary_card_pubkey: m.b64, issued_at: ISSUED_AT, recipient_pubkey: s.b64, valid_until: "2099-01-01T00:00:00.000Z" };
    const withApp = { ...unsigned, app_signature: signBytes(K.app, canonicalize(unsigned)) };
    const sub = { ...withApp, holder_signature: signBytes(m, canonicalize(withApp)) };
    await c.registerSub({ master_card: m.addr, sub_card: s.addr, sub_card_doc_cid: await c.pin(canonicalNotary(sub)), active: true });
  }
  return { policyGenesisCid };
}

/** After genesis: the policy holder approves the notary card (a field update on the policy card). Returns the new state CID. */
export async function approveNotary(c: ChainWrites, policyGenesisCid: string, notaryCard: string): Promise<string> {
  const entry = { card_state: { approved_notaries: [notaryCard] }, code: 300, entry_type: "field_update", history: [policyGenesisCid], prev_log_root: policyGenesisCid, version: 1 };
  const head = await c.pin(encrypt(K.policy.pub, entry, `policy-approve-${notaryCard}`));
  await c.registerCard({ address: K.policy.addr, policy: IDS.metaPolicy, press: PRESS_ADDR, head_cid: head });
  return head;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const out = arg("--pins"), root = arg("--root");
  if (!out || !root) { console.error("usage: world.ts --pins FILE --root <base64url test root DER>"); process.exit(2); }
  writeFileSync(out, JSON.stringify(pins(root), null, 2) + "\n");
  console.log(`wrote ${out}`);
}
