/**
 * Generates `notary/vectors/cards/cases.json` and `coverage.json` (code-plan §7.5, mechanism 1).
 *
 * Builds card worlds with real ML-DSA-44 keys and AES-256-GCM-encrypted card documents (deterministic seeds and
 * nonces, so the output is stable), applies one mutation per check, and records the verdict of the **TypeScript
 * verifier** (`checkContributor`, which runs the real Stage 2/3/4 code and the predicate evaluator). The Rust port
 * (`notary-cards`) must reproduce every verdict and code.
 *
 *   node --experimental-strip-types scripts/gen-notary-conformance.ts           # write
 *   node --experimental-strip-types scripts/gen-notary-conformance.ts --check   # fail if the committed files differ
 *
 * Reads the built verifier (`dist/`): run `pnpm build` first.
 */
import { createCipheriv } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { sha256 } from "@noble/hashes/sha256";
import { keccak_256, sha3_256 } from "@noble/hashes/sha3";
import { hkdf } from "@noble/hashes/hkdf";
import { b64uEncode, canonicalNotary, cidOfBytes, withoutFields, checkContributor } from "../dist/notary/index.js";
import { canonicalize } from "../dist/canonicalize.js";

const OUT = new URL("../../../../notary/vectors/cards/", import.meta.url);
const te = new TextEncoder();
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

type Key = { pub: Uint8Array; sec: Uint8Array; b64: string; addr: string };
const keyCache = new Map<string, Key>();
function key(name: string): Key {
  let k = keyCache.get(name);
  if (!k) {
    const kp = ml_dsa44.keygen(sha256(te.encode(`card-notary-conformance-key-${name}`)));
    k = { pub: kp.publicKey, sec: kp.secretKey, b64: b64uEncode(kp.publicKey), addr: hex(keccak_256(kp.publicKey)) };
    keyCache.set(name, k);
  }
  return k;
}
const sign = (k: Key, msg: Uint8Array) => b64uEncode(ml_dsa44.sign(msg, k.sec, { extraEntropy: false }));

function encrypt(forKey: Key, obj: unknown, nonceSeed: string): Uint8Array {
  const contentKey = hkdf(sha3_256, forKey.pub, undefined, te.encode("card-content-v1"), 32);
  const nonce = sha256(te.encode(`nonce-${nonceSeed}`)).subarray(0, 12);
  const c = createCipheriv("aes-256-gcm", contentKey, nonce);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj))), c.final()]);
  return new Uint8Array(Buffer.concat([nonce, ct, c.getAuthTag()]));
}

type World = {
  cards: Record<string, { log_head_cid: string; policy_address: string; last_press_address: string; events: { cid: string; timestamp: string }[] }>;
  subcards: Record<string, { master_card_address: string; sub_card_doc_cid: string; active: boolean }>;
  ipfs: Record<string, string>;
};

const T_ISSUED = "2026-01-01T00:00:00.000Z";
const NOW = "2027-06-01T00:00:00.000Z";

/** A mutable description of everything a case can change. */
interface Spec {
  pDoc: Record<string, unknown>;
  mDoc: Record<string, unknown>;
  aDoc: Record<string, unknown>;
  sDoc: Record<string, unknown>;
  lsDoc?: Record<string, unknown>;
  /** Sign the sub-card document with these keys (defaults: app A, holder M). */
  appSigner: string;
  holderSigner: string;
  subActive: boolean;
  subMaster: string;
  input: Record<string, unknown>;
  inputSigner: string;
  inputSigKey: string;
  predicate: unknown;
  parameters: Record<string, unknown>;
  config: { trustedRoots: string[]; appCertificationRoot: string; loginServiceCertificationRoot: string; nowIso: string; maxChainDepth?: number };
  /** Per-card hooks applied to the built world. */
  post?: (w: World) => void;
  /** Replace a card's head by a log entry (revocation etc.). */
  heads?: Record<string, { entry: Record<string, unknown>; at: string; claimedHistory?: (genesis: string) => string[] }>;
}

function base(): Spec {
  const [R, P, M, S, A, AC, LS] = ["R", "P", "M", "S", "A", "AC", "LS"].map(key);
  const card = (k: Key, policy: string, ancestry: string[], extra: Record<string, unknown> = {}) => ({
    ancestry_pubkeys: ancestry, holder_signature: "h", issued_at: T_ISSUED, issuer_card: "x", issuer_signature: "i",
    policy_id: policy, press_card: "p", press_signature: "s", protocol_version: "0.1", recipient_pubkey: k.b64, ...extra,
  });
  return {
    pDoc: card(P!, "bafkreirootpolicy", [R!.b64], { tier: "chapter" }),
    mDoc: card(M!, "bafkreisource", [P!.b64, R!.b64], { active_subcards: [S!.b64], member_level: "gold" }),
    aDoc: card(A!, "bafkreiapps", [AC!.b64]),
    sDoc: { app_card: A!.addr, app_card_pubkey: A!.b64, attestation_level: "T2", capabilities: ["notary_input"], holder_primary_card: M!.addr,
      holder_primary_card_pubkey: M!.b64, issued_at: T_ISSUED, recipient_pubkey: S!.b64, valid_until: "2099-01-01T00:00:00.000Z" },
    appSigner: "A", holderSigner: "M", subActive: true, subMaster: M!.addr,
    input: { chain_ref: { block_hash: b64uEncode(new Uint8Array(32)), block_number: 1 }, contributor_card: M!.addr, contributor_card_pubkey: M!.b64,
      evidence: [], job_hash: b64uEncode(sha256(te.encode("job"))), payload: { choice: "yes" }, revision: 0, signed_at: "2027-05-01T00:00:00.000Z", type: "notary.input.v1" },
    inputSigner: "S", inputSigKey: "S",
    predicate: { all_of: [{ issued_under_template: { param: "source_policy" } }, { card_field_matches: { template: "bafkreisource", field: "member_level", regex: "gold|silver" } }] },
    parameters: { source_policy: "bafkreisource" },
    config: { trustedRoots: [R!.addr], appCertificationRoot: AC!.addr, loginServiceCertificationRoot: LS!.addr, nowIso: NOW },
  };
}

function build(s: Spec): { world: World; input: Record<string, unknown> } {
  const w: World = { cards: {}, subcards: {}, ipfs: {} };
  const put = (bytes: Uint8Array) => { const cid = cidOfBytes(bytes); w.ipfs[cid] = b64uEncode(bytes); return cid; };
  const addCard = (name: string, doc: Record<string, unknown>) => {
    const k = key(name);
    const genesis = put(encrypt(k, doc, `${name}-genesis-${JSON.stringify(doc)}`));
    const events = [{ cid: genesis, timestamp: T_ISSUED }];
    let head = genesis;
    const h = s.heads?.[name];
    if (h) {
      const entry = { ...h.entry, history: h.claimedHistory ? h.claimedHistory(genesis) : [genesis] };
      head = put(encrypt(k, entry, `${name}-head-${JSON.stringify(entry)}`));
      events.push({ cid: head, timestamp: h.at });
    }
    w.cards[k.addr] = { log_head_cid: head, policy_address: "0xpolicy", last_press_address: "0xpress", events };
  };
  addCard("P", s.pDoc);
  addCard("M", s.mDoc);
  addCard("A", s.aDoc);
  if (s.lsDoc) addCard("LS", s.lsDoc);
  const unsigned = { ...s.sDoc };
  const appSig = sign(key(s.appSigner), canonicalize(withoutFields(unsigned, "app_signature", "holder_signature")));
  const withApp = { ...unsigned, app_signature: appSig };
  const sub = { ...withApp, holder_signature: sign(key(s.holderSigner), canonicalize(withoutFields(withApp, "holder_signature"))) };
  w.subcards[key("S").addr] = { master_card_address: s.subMaster, sub_card_doc_cid: put(canonicalNotary(sub)), active: s.subActive };
  const sigKey = key(s.inputSigKey);
  const input = { ...s.input, contributor_signature: { public_key: sigKey.b64, signature: sign(key(s.inputSigner), canonicalNotary(s.input)) } };
  s.post?.(w);
  return { world: w, input };
}

type Case = { id: string; checks: string[]; mutate: (s: Spec) => void };
const K = key;
const revoked = (code: number, at: string) => ({ entry: { card_state: {}, code, entry_type: "revocation", prev_log_root: "x", revocation: { effective_date: at }, version: 1 }, at });

const cases: Case[] = [
  { id: "ok", checks: ["*"], mutate: () => {} },
  { id: "ok_root_key_from_past_keys", checks: ["root_key"], mutate: (s) => { s.mDoc["past_keys"] = [{ pubkey: K("Mold").b64, rotated_at: T_ISSUED, valid_from: "2025-01-01T00:00:00.000Z" }]; } },
  // B5: the signing sub-card
  { id: "b5_subcard_unregistered", checks: ["B5.registered"], mutate: (s) => { s.post = (w) => { delete w.subcards[K("S").addr]; }; } },
  { id: "b5_signer_not_a_subcard", checks: ["B5.registered"], mutate: (s) => { s.inputSigKey = "X"; s.inputSigner = "X"; } },
  { id: "b5_subcard_recipient_mismatch", checks: ["B5.recipient_binding"], mutate: (s) => { s.sDoc["recipient_pubkey"] = K("X").b64; } },
  { id: "b5_holder_pointer_mismatch", checks: ["B5.holder_binding"], mutate: (s) => { s.sDoc["holder_primary_card"] = K("P").addr; } },
  { id: "b5_app_pointer_mismatch", checks: ["B5.app_binding"], mutate: (s) => { s.sDoc["app_card"] = K("P").addr; } },
  { id: "b5_master_card_missing", checks: ["B5.master_exists"], mutate: (s) => { s.post = (w) => { delete w.cards[K("M").addr]; }; } },
  { id: "b5_not_in_active_subcards", checks: ["B5.active_subcards"], mutate: (s) => { s.mDoc["active_subcards"] = []; } },
  { id: "b5_registration_other_master", checks: ["B5.registration_master"], mutate: (s) => { s.subMaster = K("P").addr; } },
  { id: "b5_bad_holder_signature", checks: ["B5.holder_signature"], mutate: (s) => { s.holderSigner = "X"; } },
  { id: "b5_subcard_inactive", checks: ["B5.active"], mutate: (s) => { s.subActive = false; } },
  { id: "b5_bad_app_signature", checks: ["B5.app_signature"], mutate: (s) => { s.appSigner = "X"; } },
  { id: "b5_app_chain_untrusted", checks: ["B5.app_chain"], mutate: (s) => { s.aDoc["ancestry_pubkeys"] = [K("R").b64]; } },
  { id: "b5_login_service_scope", checks: ["B5.login_scope"], mutate: (s) => {
    s.aDoc["ancestry_pubkeys"] = [K("LS").b64];
    s.lsDoc = { ancestry_pubkeys: [K("AC").b64], policy_id: "bafkreilogin", recipient_pubkey: K("LS").b64 };
  } },
  { id: "b5_attestation_s1", checks: ["B5.attestation_level"], mutate: (s) => { s.sDoc["attestation_level"] = "S1"; } },
  { id: "b5_attestation_t1", checks: ["B5.attestation_level"], mutate: (s) => { s.sDoc["attestation_level"] = "T1"; } },
  { id: "b5_missing_capability", checks: ["B5.capability"], mutate: (s) => { s.sDoc["capabilities"] = ["chat_message"]; } },
  { id: "b5_valid_until_passed", checks: ["B5.valid_until"], mutate: (s) => { s.sDoc["valid_until"] = "2027-01-01T00:00:00.000Z"; } },
  { id: "b5_bad_input_signature", checks: ["B5.input_signature"], mutate: (s) => { s.inputSigner = "M"; } },
  // B6
  { id: "b6_contributor_card_mismatch", checks: ["B6"], mutate: (s) => { s.input["contributor_card"] = K("P").addr; } },
  { id: "b6_contributor_pubkey_mismatch", checks: ["B6"], mutate: (s) => { s.input["contributor_card_pubkey"] = K("P").b64; } },
  // B7
  { id: "b7_no_trusted_root", checks: ["B7.trusted_root"], mutate: (s) => { s.config.trustedRoots = []; } },
  { id: "b7_ancestor_missing", checks: ["B7.ancestor_exists"], mutate: (s) => { s.post = (w) => { delete w.cards[K("P").addr]; }; } },
  { id: "b7_ancestor_undecryptable", checks: ["B7.ancestor_decrypts"], mutate: (s) => {
    s.post = (w) => { const c = w.cards[K("P").addr]!; const bytes = encrypt(K("X"), s.pDoc, "wrong-key"); const cid = cidOfBytes(bytes); w.ipfs[cid] = b64uEncode(bytes); c.log_head_cid = cid; c.events = [{ cid, timestamp: T_ISSUED }]; };
  } },
  { id: "b7_chain_too_deep", checks: ["B7.depth"], mutate: (s) => { s.config.maxChainDepth = 1; } },
  { id: "b7_master_revoked_8xx", checks: ["B7.revocation"], mutate: (s) => { s.heads = { M: revoked(810, "2027-03-01T00:00:00.000Z") }; } },
  { id: "b7_ancestor_revoked_9xx", checks: ["B7.revocation"], mutate: (s) => { s.heads = { P: revoked(910, "2027-02-01T00:00:00.000Z") }; } },
  { id: "b7_revoked_after_chain_time", checks: ["B7.revocation"], mutate: (s) => { s.heads = { M: revoked(810, "2027-09-01T00:00:00.000Z") }; } },
  { id: "b7_master_expired", checks: ["B7.expires_at"], mutate: (s) => { s.mDoc["expires_at"] = "2026-06-01T00:00:00.000Z"; } },
  { id: "b7_not_yet_expired", checks: ["B7.expires_at"], mutate: (s) => { s.mDoc["expires_at"] = "2099-06-01T00:00:00.000Z"; } },
  { id: "b7_history_mismatch", checks: ["B7.history"], mutate: (s) => { s.heads = { M: { ...revoked(810, "2027-09-01T00:00:00.000Z"), claimedHistory: (g) => [g, "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] } }; } },
  { id: "b7_history_empty_breaks_state", checks: ["B7.history"], mutate: (s) => { s.heads = { M: { ...revoked(810, "2027-09-01T00:00:00.000Z"), claimedHistory: () => [] } }; } },
  { id: "b7_field_update_not_revoked", checks: ["B7.revocation"], mutate: (s) => { s.heads = { M: { entry: { card_state: { member_level: "silver" }, code: 301, entry_type: "field_update", prev_log_root: "x", version: 1 }, at: "2027-01-01T00:00:00.000Z" } }; } },
  // B8: predicates
  { id: "b8_template_param_mismatch", checks: ["B8.issued_under_template", "B8.param"], mutate: (s) => { s.parameters = { source_policy: "bafkreiother" }; } },
  { id: "b8_param_missing", checks: ["B8.param"], mutate: (s) => { s.parameters = {}; } },
  { id: "b8_field_regex_mismatch", checks: ["B8.card_field_matches", "B8.all_of"], mutate: (s) => { s.mDoc["member_level"] = "bronze"; } },
  { id: "b8_field_regex_is_full_match", checks: ["B8.card_field_matches"], mutate: (s) => { s.mDoc["member_level"] = "golden"; } },
  { id: "b8_field_on_ancestor", checks: ["B8.card_field_matches"], mutate: (s) => { s.predicate = { card_field_matches: { field: "tier", regex: "chap.*", template: "bafkreirootpolicy" } }; } },
  { id: "b8_field_after_update", checks: ["B8.card_field_matches"], mutate: (s) => {
    s.heads = { M: { entry: { card_state: { member_level: "bronze" }, code: 301, entry_type: "field_update", prev_log_root: "x", version: 1 }, at: "2027-01-01T00:00:00.000Z" } };
  } },
  { id: "b8_chain_includes_ok", checks: ["B8.chain_includes"], mutate: (s) => { s.predicate = { chain_includes: K("P").addr }; } },
  { id: "b8_chain_includes_root_ok", checks: ["B8.chain_includes"], mutate: (s) => { s.predicate = { chain_includes: K("R").addr }; } },
  { id: "b8_chain_includes_no", checks: ["B8.chain_includes"], mutate: (s) => { s.predicate = { chain_includes: K("A").addr }; } },
  { id: "b8_depth_at_most_3_ok", checks: ["B8.chain_depth_at_most"], mutate: (s) => { s.predicate = { chain_depth_at_most: 3 }; } },
  { id: "b8_depth_at_most_2_no", checks: ["B8.chain_depth_at_most"], mutate: (s) => { s.predicate = { chain_depth_at_most: 2 }; } },
  { id: "b8_none_of", checks: ["B8.none_of"], mutate: (s) => { s.predicate = { none_of: [{ issued_under_template: "bafkreisource" }] }; } },
  { id: "b8_none_of_ok", checks: ["B8.none_of"], mutate: (s) => { s.predicate = { none_of: [{ issued_under_template: "bafkreiother" }] }; } },
  { id: "b8_any_of_one", checks: ["B8.any_of"], mutate: (s) => { s.predicate = { any_of: [{ issued_under_template: "bafkreiother" }, { chain_includes: K("P").addr }] }; } },
  { id: "b8_any_of_empty", checks: ["B8.any_of"], mutate: (s) => { s.predicate = { any_of: [] }; } },
  { id: "b8_all_of_empty", checks: ["B8.all_of"], mutate: (s) => { s.predicate = { all_of: [] }; } },
  { id: "b8_unknown_leaf", checks: ["B8.fail_closed"], mutate: (s) => { s.predicate = { is_member_of: "anything" }; } },
  { id: "b8_code_equals_invalid_here", checks: ["B8.fail_closed"], mutate: (s) => { s.predicate = { code_equals: 810 }; } },
  { id: "b8_is_holder_false", checks: ["B8.fail_closed"], mutate: (s) => { s.predicate = { is_holder: true }; } },
  { id: "b8_two_keys", checks: ["B8.fail_closed"], mutate: (s) => { s.predicate = { chain_includes: K("P").addr, issued_under_template: "bafkreisource" }; } },
  { id: "b8_lookaround_regex", checks: ["B8.regex_subset"], mutate: (s) => { s.predicate = { card_field_matches: { field: "member_level", regex: "(?=g)gold", template: "bafkreisource" } }; } },
  { id: "b8_backreference_regex", checks: ["B8.regex_subset"], mutate: (s) => { s.predicate = { card_field_matches: { field: "member_level", regex: "(g)\\1?old", template: "bafkreisource" } }; } },
  { id: "b8_invalid_regex", checks: ["B8.regex_subset"], mutate: (s) => { s.predicate = { card_field_matches: { field: "member_level", regex: "(gold", template: "bafkreisource" } }; } },
  { id: "b8_param_object_value", checks: ["B8.param"], mutate: (s) => { s.predicate = { chain_includes: { param: "who" } }; s.parameters = { who: K("P").addr }; } },
];

async function main() {
  const out = [];
  for (const c of cases) {
    const spec = base();
    c.mutate(spec);
    const { world, input } = build(spec);
    const result = await checkContributor({ input, contributorPredicate: spec.predicate, parameters: spec.parameters, world, config: spec.config });
    const expect = result.ok ? { ok: true, root_key_hash: result.root_key_hash, chain_addresses: result.chain_addresses } : { ok: false, code: result.code };
    out.push({ id: c.id, checks: c.checks, config: spec.config, predicate: spec.predicate, parameters: spec.parameters, input, world, expect });
  }
  const allChecks = [...new Set(cases.flatMap((c) => c.checks).filter((x) => x !== "*"))].sort();
  const coverage = {
    about: "Each ported check (code-plan §7.5) with the cases that exercise it. CI fails if a check lacks an accepting or a rejecting case (shared accepting case: ok).",
    checks: Object.fromEntries(allChecks.map((ch) => {
      const ids = out.filter((o) => o.checks.includes(ch));
      return [ch, { accept: ["ok", ...ids.filter((o) => o.expect.ok).map((o) => o.id)], reject: ids.filter((o) => !o.expect.ok).map((o) => o.id) }];
    })),
  };
  const files: Record<string, string> = {
    "cases.json": JSON.stringify({ about: "Contributor checks B5–B8 (notary_lifecycle.md Appendix B), judged by the TypeScript verifier (checkContributor). Generated by membership_card_verifier/packages/verifier/scripts/gen-notary-conformance.ts; do not edit.", cases: out }, null, 1) + "\n",
    "coverage.json": JSON.stringify(coverage, null, 1) + "\n",
  };
  const check = process.argv.includes("--check");
  let stale = false;
  mkdirSync(OUT, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const url = new URL(name, OUT);
    if (check) {
      let cur = "";
      try { cur = readFileSync(url, "utf8"); } catch { /* missing */ }
      if (cur !== text) { console.error(`stale: notary/vectors/cards/${name} — regenerate with gen-notary-conformance.ts`); stale = true; }
    } else writeFileSync(url, text);
  }
  for (const [ch, v] of Object.entries(coverage.checks)) if (v.reject.length === 0 && ch !== "root_key") { console.error(`coverage: ${ch} has no rejecting case`); stale = true; }
  if (stale) process.exit(1);
  console.log(`${check ? "checked" : "wrote"} ${out.length} cases, ${allChecks.length} checks`);
}
await main();
