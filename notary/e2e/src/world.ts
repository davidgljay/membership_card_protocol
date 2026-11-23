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
import { mlKem768GenerateKeypair } from "@membership-card-protocol/app-sdk";
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
export function encrypt(forPub: Uint8Array, obj: unknown, nonceSeed: string, canonical = false): Uint8Array {
  const nonce = sha256(te.encode(`e2e-nonce-${nonceSeed}`)).subarray(0, 12);
  const c = createCipheriv("aes-256-gcm", contentKey(forPub), nonce);
  // `canonical`: RFC 8785 bytes, which the enclave requires of the source-card entries it opens (a field update or a revocation)
  const ct = Buffer.concat([c.update(canonical ? Buffer.from(canonicalNotary(obj as never)) : Buffer.from(JSON.stringify(obj))), c.final()]);
  return new Uint8Array(Buffer.concat([nonce, ct, c.getAuthTag()]));
}

/** What the world needs from the chain: the simulated chain over HTTP, or in-process. */
export interface ChainWrites {
  pin(bytes: Uint8Array): Promise<string>;
  registerCard(c: { address: string; policy: string; press: string; head_cid: string }): Promise<unknown>;
  registerSub(s: { master_card: string; sub_card: string; sub_card_doc_cid: string; active: boolean }): Promise<unknown>;
  /** Records which card is a policy's own card (the registry's `RegisterPolicy`), so a snapshot can name the policy's head. */
  registerPolicy(policy_id: string, address: string): Promise<unknown>;
}

export function httpChain(base: string): ChainWrites & { get<T>(path: string): Promise<T>; bytes(cid: string): Promise<Uint8Array | null> } {
  const post = async (path: string, body: unknown) => (await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  return {
    async pin(bytes) { const r = await fetch(`${base}/ipfs`, { method: "PUT", body: bytes }); return ((await r.json()) as { cid: string }).cid; },
    registerCard: (c) => post("/registry/card", c),
    registerSub: (s) => post("/registry/subcard", s),
    registerPolicy: (policy_id, address) => post("/registry/policy", { policy_id, address }),
    async get<T>(path: string) { const r = await fetch(`${base}${path}`); if (!r.ok) throw new Error(`${path}: ${r.status}`); return (await r.json()) as T; },
    async bytes(cid: string) { const r = await fetch(`${base}/ipfs/${cid}`); return r.ok ? new Uint8Array(await r.arrayBuffer()) : null; },
  };
}

// ---- fixed identities ---------------------------------------------------------------------------------------------

export const K = {
  root: key("root"), appRoot: key("app-root"), loginRoot: key("login-root"),
  chapter: key("chapter"), app: key("app"), policy: key("policy"), sourcePolicy: key("source-policy-card"), requester: key("requester"), operator: key("operator"),
  listRuntimes: key("list-runtimes"), listPrograms: key("list-programs"), listHolder: key("list-holder"), press: key("press"),
  host: key("host"), template: key("derive-template"), srcPress: key("source-press"), vote: key("vote-policy"), templateExp: key("expiry-template"), adv: key("adversarial-policy"),
};
/** The ML-KEM-768 seed of contributor `i`'s sub-card (a device would keep the key in secure storage). */
export const kemSeed = (i: number) => Uint8Array.from({ length: 64 }, (_, j) => (j * 13 + i * 7 + 1) & 0xff);
export const kemKeypair = (i: number) => mlKem768GenerateKeypair(kemSeed(i));
/** The contributor index of a member who is registered, with a valid notary_input sub-card, under a policy that is not the contributors'. */
export const OUTSIDER = 50;
export const contributor = (i: number) => ({ card: key(`member-${i}`), sub: key(`member-${i}-sub`) });

// the committed `aggregate` template module and its policy (templates/aggregate, step 6.1)
const TEMPLATE = new URL("../../templates/", import.meta.url);
export const PROGRAM = new Uint8Array(readFileSync(new URL("modules/aggregate.wasm", TEMPLATE)));
const TEMPLATE_POLICY = JSON.parse(readFileSync(new URL("aggregate/policy.json", TEMPLATE), "utf8")).notary as Record<string, unknown>;
export const PROGRAM_CID = cidOfBytes(PROGRAM);
export const SIM_PCR0 = b64uEncode(new Uint8Array(48).fill(0x42));
const marker = (name: string) => canonicalNotary({ e2e: name, type: "e2e.policy_marker" });
const META_MARKER = cidOfBytes(canonicalNotary({ e2e: "meta-policy", type: "e2e.policy_marker" }));
/**
 * The contributors' policy as a real document (Phase 7): its genesis is what a derived-card job reads for the field control
 * (`derivable`, 6.5a). `home_address` is marked not derivable; `member_level` is derivable by default.
 */
/** The press's published document: `approved_presses` names it by CID (the enclave reads the press key from it, then the press's card by address). */
export const SRC_PRESS_DOC = { ancestry_pubkeys: [K.root.b64], recipient_pubkey: K.srcPress.b64, type: "press" };
export const SRC_PRESS_DOC_CID = cidOfBytes(canonicalNotary(SRC_PRESS_DOC));
export const SOURCE_POLICY_DOC = {
  ancestry_pubkeys: [K.root.b64], field_definitions: [{ name: "member_level", type: "text", required: true }, { name: "home_address", type: "text", required: false, derivable: false }],
  issued_at: ISSUED_AT, issuer_card: "x", policy_id: META_MARKER, recipient_pubkey: K.sourcePolicy.b64, type: "policy",
  // the press whose signature makes a source card's update count for revocation propagation (E4)
  approved_presses: [SRC_PRESS_DOC_CID],
};
/** Template and policy identifiers: CIDs of small pinned marker documents (the source policy: its genesis document). */
export const IDS = {
  rootPolicy: cidOfBytes(marker("root-policy")), sourcePolicy: cidOfBytes(canonicalNotary(SOURCE_POLICY_DOC)), appsPolicy: cidOfBytes(marker("apps")),
  metaPolicy: cidOfBytes(marker("meta-policy")), notaryCardPolicy: cidOfBytes(marker("notary-card-policy")), listsPolicy: cidOfBytes(marker("lists")),
};
// ---- the derive template (Phase 7): the committed `derive` module under a template policy with this world's test values ----
export const DERIVE_MODULE = new Uint8Array(readFileSync(new URL("modules/derive.wasm", TEMPLATE)));
export const DERIVE_PROGRAM_CID = cidOfBytes(DERIVE_MODULE);
const DERIVE_POLICY = JSON.parse(readFileSync(new URL("derive/policy.json", TEMPLATE), "utf8")) as { notary: Record<string, unknown> };
/** Hourly batches, a one-day period with a six-hour renewal window, an anonymity set of three: the test values `notary-broker/tests/derive.rs` uses. */
export const DERIVE_PARAMS = { issuance_batch_interval: "PT1H", min_anonymity_set: 3, min_batch_size: 2, nullifier_period: "P1D", renewal_window: "PT6H", source_kind: "card" };
/** `sealed_link` with short timing, as in the broker tests: a one-hour minimum delay, hourly windows, batches of at least two. */
export const DERIVE_PROPAGATION = { batch_window: "PT1H", min_delay: "PT1H", min_revocation_batch: 2, mode: "sealed_link" };
export const DERIVE_NOTARY_SECTION = { ...DERIVE_POLICY.notary, platform: "simulator", program_cid: DERIVE_PROGRAM_CID, derived_card: DERIVE_PARAMS, revocation_propagation: DERIVE_PROPAGATION };
/** The template policy T: a plain document (`field_definitions` in the object form Stage 5 reads, as in the broker fixture) with the template's `notary` section. */
export const templateDoc = () => ({
  ancestry_pubkeys: [K.root.b64], approved_notaries: [] as string[], field_definitions: { dup_tag: { required: true, type: "base64url" }, projected: { required: true, type: "text" }, source_policy: { required: true, type: "cid" } },
  issued_at: ISSUED_AT, issuer_card: "x", notary: DERIVE_NOTARY_SECTION, policy_id: META_MARKER, recipient_pubkey: K.template.b64, type: "policy",
});
export const TEMPLATE_ID = cidOfBytes(canonicalNotary(templateDoc()));
/** The same template with `expiry_only` (§5): no link is kept, a source revocation causes no event, and a card lapses at `expires_at`. Its own policy card and notary card. */
export const EXPIRY_NOTARY_SECTION = { ...DERIVE_NOTARY_SECTION, revocation_propagation: { mode: "expiry_only" } };
export const expiryDoc = () => ({ ...templateDoc(), notary: EXPIRY_NOTARY_SECTION, recipient_pubkey: K.templateExp.b64 });
export const EXPIRY_ID = cidOfBytes(canonicalNotary(expiryDoc()));
export type TemplateSpec = { key: Key; doc: () => unknown; id: string };
export const SEALED: TemplateSpec = { key: K.template, doc: templateDoc, id: TEMPLATE_ID };
export const EXPIRY: TemplateSpec = { key: K.templateExp, doc: expiryDoc, id: EXPIRY_ID };
// ---- the vote template (Phase 7, 7.1): the committed `vote-yna` module under its own policy card, with this world's choices ----
export const VOTE_MODULE = new Uint8Array(readFileSync(new URL("modules/vote-yna.wasm", TEMPLATE)));
export const VOTE_PROGRAM_CID = cidOfBytes(VOTE_MODULE);
const { job_requester_predicate: _voteAnyone, ...VOTE_BODY } = (JSON.parse(readFileSync(new URL("vote-yna/policy.json", TEMPLATE), "utf8")) as { notary: Record<string, unknown> }).notary;
/** The same contributors as the aggregate policy; the tally is public (a statement on the chain), and three voters meet `k_min`. */
export const VOTE_NOTARY_SECTION = { ...VOTE_BODY, contributor_predicate: { issued_under_template: IDS.sourcePolicy }, platform: "simulator", privacy: { k_min: 3 }, program_cid: VOTE_PROGRAM_CID,
  output_recipients: { cards: [] as string[], job_requester: false, public: true } };
export const voteGenesis = { ancestry_pubkeys: [K.root.b64], approved_notaries: [] as string[], issued_at: ISSUED_AT, issuer_card: "x", notary: VOTE_NOTARY_SECTION, policy_id: IDS.metaPolicy, recipient_pubkey: K.vote.b64 };
export const VOTE_ID = cidOfBytes(canonicalNotary(voteGenesis));
// ---- the adversarial suite's policy (Phase 7.2): the committed `vote` module (8 options), which is NOT on the program allowlist ----
export const ADV_MODULE = new Uint8Array(readFileSync(new URL("modules/vote.wasm", TEMPLATE)));
export const ADV_PROGRAM_CID = cidOfBytes(ADV_MODULE);
const { job_requester_predicate: _advAnyone, ...ADV_BODY } = (JSON.parse(readFileSync(new URL("vote/policy.json", TEMPLATE), "utf8")) as { notary: Record<string, unknown> }).notary;
/** A legitimate audited template under a policy whose program is not allowlisted, asking for `shared` isolation. */
export const ADV_NOTARY_SECTION = { ...ADV_BODY, contributor_predicate: { issued_under_template: IDS.sourcePolicy }, platform: "simulator", privacy: { k_min: 3 }, program_cid: ADV_PROGRAM_CID,
  output_recipients: { cards: [] as string[], job_requester: false, public: true } };
export const advGenesis = { ancestry_pubkeys: [K.root.b64], approved_notaries: [] as string[], issued_at: ISSUED_AT, issuer_card: "x", notary: ADV_NOTARY_SECTION, policy_id: IDS.metaPolicy, recipient_pubkey: K.adv.b64 };
export const ADV_ID = cidOfBytes(canonicalNotary(advGenesis));
export const PRESS_ADDR = "0x" + "11".repeat(20);

export const OUTPUT_SCHEMA = TEMPLATE_POLICY["output_schema"];
/** The aggregate template's policy with this world's placeholders filled in (the community's own choices: who may contribute, k_min). */
const { job_requester_predicate: _anyoneMayRequest, ...TEMPLATE_BODY } = TEMPLATE_POLICY;
export const NOTARY_SECTION = {
  ...TEMPLATE_BODY, contributor_predicate: { issued_under_template: IDS.sourcePolicy }, platform: "simulator", privacy: { k_min: 3 }, program_cid: PROGRAM_CID,
  // the result goes privately to contributor 0 (6.1): one message per active sub-card, encrypted to its kem_pubkey
  output_recipients: { cards: [contributor(0).card.addr], job_requester: false, public: false },
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
// `DERIVE_PROGRAM_CID` is declared below the template section; the list is read at registration time
const program = (name: string, cid: string) => ({ accepted_from: "2026-01-01T00:00:00Z", audit_report_cid: IDS.listsPolicy, name, program_cid: cid, source_commit: "e2e", toolchain: "rust", version: "1" });
export const PROGRAMS = [program("aggregate", PROGRAM_CID), program("derive", cidOfBytes(new Uint8Array(readFileSync(new URL("modules/derive.wasm", TEMPLATE))))), program("vote-yna", cidOfBytes(new Uint8Array(readFileSync(new URL("modules/vote-yna.wasm", TEMPLATE)))))];

export function approval(list: string, cardAddr: string, value: unknown): string {
  const a: Record<string, unknown> = { governance_version: 1, kind: "standard", list, list_card: cardAddr, list_hash: H(value), list_version: 1, signatures: [], type: "notary_list_approval" };
  const digest = b64uDecode(H(withoutFields(a, "signatures")), 32);
  a["signatures"] = [0, 1, 2, 3].map((i) => ({ key_index: i, signature: b64uEncode(p256.sign(digest, members[i]!.sk, { prehash: false, lowS: false }).toCompactRawBytes()) }));
  return new TextDecoder().decode(canonicalNotary(a));
}

function listGenesis(k: Key, field: string, value: unknown) {
  const doc: Record<string, unknown> = { [field]: value, ancestry_pubkeys: [K.root.b64], list_approval: approval(field, k.addr, value), policy_id: IDS.listsPolicy, recipient_pubkey: k.b64 };
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
  await c.pin(canonicalNotary(SOURCE_POLICY_DOC));
  await c.pin(canonicalNotary(SRC_PRESS_DOC));
  await c.pin(canonicalNotary(expiryDoc())); // the expiry_only variant
  await c.pin(canonicalNotary(templateDoc())); // the derive template T: a genesis request for its notary names it (E11)
  for (const n of ["root-policy", "apps", "meta-policy", "notary-card-policy", "lists"]) await c.pin(marker(n));
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
  await reg(K.srcPress, IDS.rootPolicy, card(K.srcPress, IDS.rootPolicy, [K.root.b64], { role: "press" }), "source-press");
  await reg(K.app, IDS.appsPolicy, card(K.app, IDS.appsPolicy, [K.appRoot.b64]), "app");
  await reg(K.requester, IDS.sourcePolicy, card(K.requester, IDS.sourcePolicy, [K.chapter.b64, K.root.b64], { role: "organizer" }), "requester");
  await reg(K.operator, IDS.sourcePolicy, card(K.operator, IDS.sourcePolicy, [K.chapter.b64, K.root.b64], { role: "operator" }), "operator");
  // the policy: plain document at policy_id, encrypted genesis in the registry
  await c.pin(canonicalNotary(policyGenesis));
  const policyGenesisCid = await reg(K.policy, IDS.metaPolicy, policyGenesis, "policy-genesis");
  // the contributors' policy has a card of its own (its head is what a snapshot records, 6.0a)
  await reg(K.sourcePolicy, IDS.metaPolicy, SOURCE_POLICY_DOC, "source-policy-card");
  await c.registerPolicy(IDS.sourcePolicy, K.sourcePolicy.addr);
  // contributors, each with a notary_input signing sub-card; then one more member who holds the same kind of sub-card but under another policy (the adversarial suite's outsider)
  for (const [i, policy] of [...Array.from({ length: nContributors }, (_, k) => [k, IDS.sourcePolicy] as const), [OUTSIDER, IDS.appsPolicy] as const]) {
    const { card: m, sub: s } = contributor(i);
    await reg(m, policy, card(m, policy, [K.chapter.b64, K.root.b64], { active_subcards: [s.b64], member_level: "gold" }), `member-${i}`);
    const unsigned = { app_card: K.app.addr, app_card_pubkey: K.app.b64, attestation_level: "T2", capabilities: ["notary_input"], holder_primary_card: m.addr,
      holder_primary_card_pubkey: m.b64, issued_at: ISSUED_AT, kem_pubkey: b64uEncode(kemKeypair(i).publicKey), recipient_pubkey: s.b64, valid_until: "2099-01-01T00:00:00.000Z" };
    const withApp = { ...unsigned, app_signature: signBytes(K.app, canonicalize(unsigned)) };
    const sub = { ...withApp, holder_signature: signBytes(m, canonicalize(withApp)) };
    await c.registerSub({ master_card: m.addr, sub_card: s.addr, sub_card_doc_cid: await c.pin(canonicalNotary(sub)), active: true });
  }
  return { policyGenesisCid };
}

/** After genesis: the policy holder approves the notary card (a field update on the policy card). Returns the new state CID. */
export async function approveNotary(c: ChainWrites, policyGenesisCid: string, notaryCard: string | string[]): Promise<string> {
  const cards = Array.isArray(notaryCard) ? notaryCard : [notaryCard];
  const entry = { card_state: { approved_notaries: cards }, code: 300, entry_type: "field_update", history: [policyGenesisCid], prev_log_root: policyGenesisCid, version: 1 };
  const head = await c.pin(encrypt(K.policy.pub, entry, `policy-approve-${cards.join("-")}`));
  await c.registerCard({ address: K.policy.addr, policy: IDS.metaPolicy, press: PRESS_ADDR, head_cid: head });
  return head;
}

/**
 * The derive template T: its policy card is registered (and is the policy's own card), the pinned document is the job's
 * `policy_id`, and, once the notary card exists, the policy holder approves it and `AuthorizePress` (here the sim chain's
 * `press-auth`) gives it the notary's chain key, so the write gate accepts the notary's `RegisterCard` for derived cards.
 * Returns the state CID of the template's head after the approval.
 */
export async function registerTemplate(c: ChainWrites, notaryCard: string, notaryChainKeyB64: string, post: (path: string, body: unknown) => Promise<unknown>, t: TemplateSpec = SEALED): Promise<string> {
  await c.pin(canonicalNotary(t.doc()));
  await c.pin(DERIVE_MODULE);
  const genesis = await c.pin(encrypt(t.key.pub, t.doc(), `template-genesis-${t.id}`));
  await c.registerCard({ address: t.key.addr, policy: IDS.metaPolicy, press: PRESS_ADDR, head_cid: genesis });
  await c.registerPolicy(t.id, t.key.addr);
  const entry = { card_state: { approved_notaries: [notaryCard] }, code: 300, entry_type: "field_update", history: [genesis], prev_log_root: genesis, version: 1 };
  const head = await c.pin(encrypt(t.key.pub, entry, `template-approve-${notaryCard}`));
  await c.registerCard({ address: t.key.addr, policy: IDS.metaPolicy, press: PRESS_ADDR, head_cid: head });
  await post("/registry/press-auth", { policy: t.key.addr, press: notaryCard, key: notaryChainKeyB64 });
  return head;
}

/**
 * The vote policy: its card is registered, the pinned document is the job's `policy_id`, and the policy holder approves the
 * vote's own notary card (a notary card is issued under one policy, W10). Returns the state CID after the approval.
 */
export async function registerVote(c: ChainWrites, notaryCard: string | string[]): Promise<string> {
  const approved = Array.isArray(notaryCard) ? notaryCard : [notaryCard];
  await c.pin(canonicalNotary(voteGenesis));
  await c.pin(VOTE_MODULE);
  const genesis = await c.pin(encrypt(K.vote.pub, voteGenesis, "vote-genesis"));
  await c.registerCard({ address: K.vote.addr, policy: IDS.metaPolicy, press: PRESS_ADDR, head_cid: genesis });
  const entry = { card_state: { approved_notaries: approved }, code: 300, entry_type: "field_update", history: [genesis], prev_log_root: genesis, version: 1 };
  const head = await c.pin(encrypt(K.vote.pub, entry, `vote-approve-${approved.join("-")}`));
  await c.registerCard({ address: K.vote.addr, policy: IDS.metaPolicy, press: PRESS_ADDR, head_cid: head });
  return head;
}

/** The adversarial policy: registered and its notary approved, like `registerVote`. Returns the state CID. */
export async function registerAdv(c: ChainWrites, notaryCard: string): Promise<string> {
  await c.pin(canonicalNotary(advGenesis));
  await c.pin(ADV_MODULE);
  const genesis = await c.pin(encrypt(K.adv.pub, advGenesis, "adv-genesis"));
  await c.registerCard({ address: K.adv.addr, policy: IDS.metaPolicy, press: PRESS_ADDR, head_cid: genesis });
  const entry = { card_state: { approved_notaries: [notaryCard] }, code: 300, entry_type: "field_update", history: [genesis], prev_log_root: genesis, version: 1 };
  const head = await c.pin(encrypt(K.adv.pub, entry, `adv-approve-${notaryCard}`));
  await c.registerCard({ address: K.adv.addr, policy: IDS.metaPolicy, press: PRESS_ADDR, head_cid: head });
  return head;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const out = arg("--pins"), root = arg("--root");
  if (!out || !root) { console.error("usage: world.ts --pins FILE --root <base64url test root DER>"); process.exit(2); }
  writeFileSync(out, JSON.stringify(pins(root), null, 2) + "\n");
  console.log(`wrote ${out}`);
}
