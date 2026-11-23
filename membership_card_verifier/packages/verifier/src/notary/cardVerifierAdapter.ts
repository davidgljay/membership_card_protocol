/**
 * The `CardVerifier`-backed reads behind Stage 5 step 3a (card_verifier.md §7.5; notary_lifecycle.md A.3, A.5, A.6).
 *
 * `CardVerifier` builds `makeNotaryCheck(...)` and hands it to Stage 5 as the `notaryCheck` hook. Everything is read
 * from the registry and IPFS through the verifier's own providers, never from a notary host:
 * - the two governance list cards are read from their pinned public keys (F4a, 2026-11-21), their verified logs
 *   checked with algorithm L against `getGovernanceKeyset`, and the card itself with Stages 3–5 (`listCardTrusted`);
 * - the notary card is decrypted with the key its derived cards carry as `ancestry_pubkeys[0]`;
 * - the genesis PCR0 for algorithm E comes from the attestation module's `verifyEnvelope`, so no AWS format is parsed
 *   here (G5).
 */
import { aes256gcmDecrypt, hkdfSha3256, keccak256 } from "../crypto.js";
import type { IpfsProvider, NotaryStage5Hook, RpcProvider, VerifierConfig } from "../types.js";
import { b64uDecode, digestFromCid, b64uEncode } from "./canonical.js";
import { sha256 } from "@noble/hashes/sha256";
import { makeKeyExposureRead } from "./exposure.js";
import { verifyListApproval } from "./lists.js";
import type { ListVersion } from "./lists.js";
import { verifyNotaryIssuedCard } from "./derived.js";
import type { NotaryIssuedResult } from "./derived.js";
import { NOTARY_CODES } from "./types.js";
import type { AcceptedRuntime, AllowlistedProgram, NotaryCardFields, NotarySection } from "./types.js";

export type NotaryVerifierConfig = NonNullable<VerifierConfig["notary"]>;

/** Builds `VerifierConfig.notary.stage5Hook` (card_verifier.md §5, F5): `notary: { ...cfg, stage5Hook: notaryStage5Hook(cfg) }`. */
export function notaryStage5Hook(cfg: Omit<NotaryVerifierConfig, "stage5Hook">): NotaryStage5Hook {
  return (ctx) => makeNotaryCheck({ deps: { rpc: ctx.rpc, ipfs: ctx.ipfs, notary: cfg, nowMs: ctx.nowMs, listCardTrusted: ctx.listCardTrusted }, cardDoc: ctx.cardDoc, cardAddress: ctx.cardAddress })();
}
type Doc = Record<string, unknown>;
const dec = new TextDecoder();

export interface NotaryAdapterDeps {
  rpc: RpcProvider;
  ipfs: IpfsProvider;
  notary: NotaryVerifierConfig;
  nowMs: number;
  /** Stages 3–5 on a list card: its chain reaches a pinned root and nothing fails (`CardVerifier.verifyCard`). */
  listCardTrusted(address: string, pubkey: Uint8Array): Promise<boolean>;
}

/** A card that, by its own fields, claims to be a derived card (`issuer_card == press_card` and a `dup_tag`). */
export function looksDerived(doc: Doc): boolean {
  return typeof doc["press_card"] === "string" && doc["issuer_card"] === doc["press_card"] && typeof doc["dup_tag"] === "string";
}

const fetchOrNull = async (ipfs: IpfsProvider, cid: string): Promise<Uint8Array | null> => { try { return await ipfs.fetch(cid); } catch { return null; } };
const parse = (b: Uint8Array): Doc | null => { try { const v = JSON.parse(dec.decode(b)); return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Doc) : null; } catch { return null; } };

/** A card document, or a log entry overlaid on its genesis (as `decryptCardHead` does), each ADR-006 encrypted or plain. */
async function readCard(ipfs: IpfsProvider, cid: string, pub: Uint8Array): Promise<Doc | null> {
  const key = hkdfSha3256(pub, "card-content-v1");
  const one = async (c: string): Promise<Doc | null> => {
    const b = await fetchOrNull(ipfs, c);
    if (!b) return null;
    try { const p = parse(await aes256gcmDecrypt(key, b)); if (p) return p; } catch { /* plain */ }
    return parse(b);
  };
  const head = await one(cid);
  if (!head || (head["entry_type"] !== "field_update" && head["entry_type"] !== "revocation")) return head;
  const g = Array.isArray(head["history"]) ? (head["history"][0] as string | undefined) : undefined;
  const genesis = g ? await one(g) : {};
  if (!genesis) return null;
  return { ...genesis, ...((head["card_state"] as Doc | undefined) ?? {}) };
}

export type VerifiedListsRead =
  | { ok: true; acceptedRuntimes: AcceptedRuntime[]; programAllowlist: AllowlistedProgram[]; singleOperatorQuorums?: "allowed" | "refused" }
  | { ok: false; code: string; detail: string };

/** Both governance lists, each passed through algorithm L (and its card through Stages 3–5) before use. */
export async function readVerifiedLists(d: NotaryAdapterDeps): Promise<VerifiedListsRead> {
  const bad = (code: string, detail: string) => ({ fail: { ok: false as const, code, detail } });
  if (!d.rpc.getGovernanceKeyset) return bad(NOTARY_CODES.CONFIG_MISSING, "the RPC provider has no getGovernanceKeyset").fail;
  const keyset = await d.rpc.getGovernanceKeyset("PressRegistryBody");
  const one = async (list: "accepted_runtimes" | "program_allowlist", address: string, pubB64: string) => {
    let pub: Uint8Array;
    try { pub = b64uDecode(pubB64, 1312); } catch { return bad(NOTARY_CODES.CONFIG_MISSING, `${list}: the pinned list-card key is malformed`); }
    if (keccak256(pub) !== address) return bad(NOTARY_CODES.CONFIG_MISSING, `${list}: the pinned key does not hash to the list card's address`);
    if (!(await d.listCardTrusted(address, pub))) return bad("LIST_CARD_UNTRUSTED", `${list}: the list card fails Stages 3–5`);
    const history: ListVersion[] = [];
    for (const e of await d.rpc.getCardEventLog(address)) {
      const doc = await readCard(d.ipfs, e.cid, pub);
      if (!doc || !Array.isArray(doc[list])) return bad("LIST_APPROVAL_MALFORMED", `${list}: a version of the list card is unreadable`);
      history.push({ value: doc[list] as unknown[], approvalText: typeof doc["list_approval"] === "string" ? doc["list_approval"] : undefined });
    }
    return verifyListApproval({ list, listCard: address, history, keyset });
  };
  const rt = await one("accepted_runtimes", d.notary.acceptedRuntimesCard, d.notary.acceptedRuntimesCardPubkey);
  if ("fail" in rt) return rt.fail;
  if (!rt.ok) return { ok: false, code: rt.code, detail: "accepted-runtime list" };
  const pr = await one("program_allowlist", d.notary.programAllowlistCard, d.notary.programAllowlistCardPubkey);
  if ("fail" in pr) return pr.fail;
  if (!pr.ok) return { ok: false, code: pr.code, detail: "program allowlist" };
  return { ok: true, acceptedRuntimes: rt.list as AcceptedRuntime[], programAllowlist: pr.list as AllowlistedProgram[], singleOperatorQuorums: pr.singleOperatorQuorums };
}

/**
 * Stage 5 step 3a for one card. Resolves `null` when the card is not notary-issued (so Stage 5 does nothing). With
 * no `config.notary` a card that looks derived gets the warning `NOTARY_CONFIG_MISSING` and nothing else (F4b).
 */
export function makeNotaryCheck(o: { deps: Omit<NotaryAdapterDeps, "notary"> & { notary: NotaryVerifierConfig | undefined }; cardDoc: Doc; cardAddress: string }): () => Promise<NotaryIssuedResult | null> {
  const { deps, cardDoc: d } = o;
  const fail = (code: string, detail: string): NotaryIssuedResult => ({ ok: false, code, detail });
  return async () => {
    if (!looksDerived(d)) return null;
    const notaryCfg = deps.notary;
    if (!notaryCfg) return { ok: true, warnings: [NOTARY_CODES.CONFIG_MISSING], derived: {} };
    const full = { ...deps, notary: notaryCfg };
    const press = String(d["press_card"]);
    const anc = d["ancestry_pubkeys"];
    if (!Array.isArray(anc) || anc.length !== 2 || typeof anc[0] !== "string" || typeof anc[1] !== "string") return fail(NOTARY_CODES.DERIVED_SHAPE, "ancestry_pubkeys must be [notary card key, template key]");
    let kId: Uint8Array;
    try { kId = b64uDecode(anc[0], 1312); } catch { return fail(NOTARY_CODES.DERIVED_SHAPE, "the notary card key is malformed"); }
    if (keccak256(kId) !== press) return fail(NOTARY_CODES.DERIVED_SHAPE, "ancestry_pubkeys[0] does not hash to the press card");
    const entry = await deps.rpc.getCardEntry(press);
    const card = entry?.exists ? await readCard(deps.ipfs, entry.log_head_cid, kId) : null;
    if (!card) return fail(NOTARY_CODES.GENESIS_INVALID, "the notary card cannot be read");
    if (card["policy_id"] !== notaryCfg.notaryCardPolicy) return null; // the press is not a notary card
    // the template's notary section (the derived card's policy_id is its immutable snapshot)
    const tBytes = await fetchOrNull(deps.ipfs, String(d["policy_id"]));
    const template = tBytes ? parse(tBytes) : null;
    if (!template) return fail(NOTARY_CODES.DERIVED_SHAPE, "the template policy cannot be read");
    const events = await deps.rpc.getCardEventLog(o.cardAddress);
    const registered = events[0] ? Date.parse(events[0].timestamp) : NaN;
    if (Number.isNaN(registered)) return fail(NOTARY_CODES.CONFIG_MISSING, "the derived card's registration time cannot be read");
    const lists = await readVerifiedLists(full);
    if (!lists.ok) return fail(lists.code, lists.detail);
    if (!deps.rpc.getNotaryLogAnchors) return fail(NOTARY_CODES.CONFIG_MISSING, "the RPC provider has no getNotaryLogAnchors");
    const anchors = deps.rpc.getNotaryLogAnchors.bind(deps.rpc);
    const fields = card as unknown as NotaryCardFields & { issued_at: string };
    // algorithm E needs the PCR0 of the genesis attestation; the platform module reads it, so no AWS format is parsed here
    const attBytes = await fetchOrNull(deps.ipfs, fields.genesis_attestation);
    const mod = notaryCfg.attestation.find((m) => m.platform === fields.platform);
    const root = notaryCfg.attestationRoots[fields.platform];
    const env = attBytes && mod && root ? mod.verifyEnvelope(attBytes, root) : null;
    if (!env || !env.ok) return fail(NOTARY_CODES.GENESIS_INVALID, "the genesis attestation cannot be read");
    try { if (b64uEncode(digestFromCid(fields.genesis_attestation)) !== b64uEncode(sha256(attBytes!))) return fail(NOTARY_CODES.GENESIS_INVALID, "genesis attestation does not match its CID"); }
    catch { return fail(NOTARY_CODES.GENESIS_INVALID, "genesis_attestation is not a raw CID"); }
    // The notary policy the card serves is named by its genesis request (algorithm G binds the request to the card's fields).
    // It is resolved as E11 does (card_verifier.md §7.5 step 3a, 2026-11-21): the plain policy document at that CID must
    // carry the key of the card named by the notary card's `issuer_card`.
    const reqBytes = await fetchOrNull(deps.ipfs, fields.genesis_request);
    const reqDoc = reqBytes ? parse(reqBytes) : null;
    if (!reqDoc || typeof reqDoc["policy_id"] !== "string") return fail(NOTARY_CODES.GENESIS_INVALID, "the genesis request cannot be read");
    const policyBytes = await fetchOrNull(deps.ipfs, reqDoc["policy_id"]);
    let policyPub: Uint8Array | undefined;
    try {
      const pd = policyBytes && b64uEncode(digestFromCid(reqDoc["policy_id"])) === b64uEncode(sha256(policyBytes)) ? parse(policyBytes) : null;
      policyPub = pd && typeof pd["recipient_pubkey"] === "string" ? b64uDecode(pd["recipient_pubkey"], 1312) : undefined;
    } catch { policyPub = undefined; }
    if (!policyPub) return fail(NOTARY_CODES.GENESIS_INVALID, "the notary policy document cannot be read");
    if (keccak256(policyPub) !== fields.issuer_card) return fail(NOTARY_CODES.GENESIS_INVALID, "the notary policy's key does not hash to the notary card's issuer_card");
    const fetchCid = async (c: string) => fetchOrNull(deps.ipfs, c);
    const keyExposure = makeKeyExposureRead({
      reads: { anchors: (a) => anchors(a), fetch: fetchCid },
      accepted: lists.acceptedRuntimes,
      card: async () => ({ kIdPubkey: fields.recipient_pubkey, genesisPcr0: env.measurement, genesisAttestation: fields.genesis_attestation }),
    });
    const operatorEntry = async (p: string) => { const e = await deps.rpc.getCardEntry(p); return e?.exists === true; };
    return verifyNotaryIssuedCard({
      derived: d as never, notaryCard: fields, notaryCardPointer: press, templateKey: anc[1], notaryPolicyId: reqDoc["policy_id"],
      templateNotary: { derived_card: (template["notary"] as NotarySection | undefined)?.derived_card } as never,
      registeredAtMs: registered, nowMs: deps.nowMs, cfg: { roots: notaryCfg.attestationRoots, allowSimulator: notaryCfg.allowSimulator },
      modules: notaryCfg.attestation, acceptedRuntimes: lists.acceptedRuntimes,
      reads: { fetch: fetchCid, operatorCardValid: operatorEntry, keyExposure },
    });
  };
}
