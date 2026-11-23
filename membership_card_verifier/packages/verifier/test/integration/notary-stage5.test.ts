/**
 * Stage 5 step 3a through `CardVerifier` (card_verifier.md §5, §7.5; Phase 7 F4b, F5). The notary code is injected
 * (`config.notary.stage5Hook`); the core only recognises the shape of a derived card. Same harness as
 * full-pipeline.test.ts: a sub-card signs, and its **primary card** goes through Stage 5.
 */
import { describe, it, expect, vi } from "vitest";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { CardVerifier } from "../../src/CardVerifier.js";
import { canonicalize } from "../../src/canonicalize.js";
import { generateKeypair, encryptForCard, makeCardDoc, makeSubCardDoc } from "../fixtures.js";
import type { RpcProvider, IpfsProvider, SignedMessageEnvelope, VerifierConfig } from "../../src/types.js";

const b64 = (k: Uint8Array) => Buffer.from(k).toString("base64url");

function world(masterExtra: Record<string, unknown>, notary?: VerifierConfig["notary"]) {
  const root = generateKeypair(), holder = generateKeypair(), sub = generateKeypair(), app = generateKeypair(), appRoot = generateKeypair(), press = generateKeypair();
  const POLICY = "QmPolicy", MASTER = "QmMaster", SUB = "QmSub", APP = "QmApp";
  const masterDoc = makeCardDoc(holder.publicKey, root.secretKey, holder.secretKey, press.secretKey, [b64(root.publicKey)], masterExtra);
  masterDoc.policy_id = POLICY;
  masterDoc.active_subcards = [b64(sub.publicKey)];
  const subDoc = makeSubCardDoc(holder.publicKey, holder.secretKey, app.publicKey, app.secretKey, sub.publicKey);
  const appDoc = makeCardDoc(app.publicKey, appRoot.secretKey, app.secretKey, press.secretKey, [b64(appRoot.publicKey)]);
  const enc = (k: Uint8Array, d: unknown) => encryptForCard(k, new TextEncoder().encode(JSON.stringify(d)));
  const docs: Record<string, Uint8Array> = { [SUB]: enc(sub.publicKey, subDoc), [MASTER]: enc(holder.publicKey, masterDoc), [APP]: enc(app.publicKey, appDoc), [POLICY]: new TextEncoder().encode(JSON.stringify({ field_definitions: {} })) };
  const entry = (cid: string) => ({ log_head_cid: cid, policy_address: "0x" + "f".repeat(64), last_press_address: press.address, forward_to: null, exists: true });
  const rpc: RpcProvider = {
    getCardEntry: vi.fn().mockImplementation(async (a: string) => (a === sub.address ? entry(SUB) : a === holder.address ? entry(MASTER) : a === app.address ? entry(APP) : null)),
    isPolicyAuthorizer: vi.fn().mockImplementation(async (a: string) => a === root.address),
    getPressAuthorization: vi.fn().mockResolvedValue({ press_public_key: Buffer.from(press.publicKey).toString("hex"), mldsa44_key_hash: "0x", active: true, authorized_at: "2026-01-01T00:00:00Z", revoked_at: null }),
    getSubCardEntry: vi.fn().mockImplementation(async (a: string) => (a === sub.address ? { master_card_address: holder.address, registration_log_head: "0x", sub_card_doc_cid: SUB, active: true, registered_at: "2026-01-01T00:00:00Z", deregistered_at: null } : null)),
    getCardEventLog: vi.fn().mockResolvedValue([]),
    getEasAnnotations: vi.fn().mockResolvedValue([]),
  };
  const ipfs: IpfsProvider = { fetch: vi.fn().mockImplementation(async (c: string) => { const d = docs[c]; if (!d) throw new Error(`no ${c}`); return d; }) };
  const payload = { message: "m", protocol_version: "0.1", timestamp: "2026-06-20T00:00:00Z" };
  const envelope: SignedMessageEnvelope = { payload, signatures: [{ public_key: b64(sub.publicKey), signature: Buffer.from(ml_dsa44.sign(canonicalize(payload), sub.secretKey)).toString("base64url") }] };
  const verifier = new CardVerifier({ rpc, ipfs, trustedRoots: [root.address], appCertificationRoot: appRoot.address, loginServiceCertificationRoot: "5e".repeat(32), ...(notary ? { notary } : {}) });
  return { verifier, envelope, holder };
}

const DERIVED = { dup_tag: "dGFn" }; // issuer_card == press_card below
const derivedShape = () => { const k = generateKeypair(); return { ...DERIVED, issuer_card: k.address, press_card: k.address }; };
const cfg = (hook: NonNullable<VerifierConfig["notary"]>["stage5Hook"]): VerifierConfig["notary"] => ({
  attestation: [], attestationRoots: {}, allowSimulator: false, acceptedRuntimesCard: "a", programAllowlistCard: "b", acceptedRuntimesCardPubkey: "A", programAllowlistCardPubkey: "B", notaryCardPolicy: "c", ...(hook ? { stage5Hook: hook } : {}),
});
const run = async (w: ReturnType<typeof world>) => (await w.verifier.verifyEnvelope(w.envelope)).signatures[0]!;

describe("Stage 5 step 3a is wired into CardVerifier", () => {
  it("an ordinary card gets no notary result and is untouched (negative control)", async () => {
    const s = await run(world({}));
    expect(s.policy_compliant).toBe(true);
    expect(s.notary).toBeUndefined();
  });
  it("a derived-shaped card with no notary hook gets the warning NOTARY_CONFIG_MISSING, and is not failed (F4b)", async () => {
    for (const notary of [undefined, cfg(undefined)]) {
      const s = await run(world(derivedShape(), notary));
      expect(s.policy_compliant).toBe(true);
      expect(s.notary).toEqual({ warnings: ["NOTARY_CONFIG_MISSING"], derived: {} });
    }
  });
  it("the injected hook receives the card, and what it returns is surfaced", async () => {
    let got: { address: string; press: unknown } | undefined;
    const w = world(derivedShape(), cfg(async (ctx) => { got = { address: ctx.cardAddress, press: ctx.cardDoc["press_card"] }; return { ok: true, warnings: ["notary_key_exposed_later"], derived: { dup_tag: "dGFn" } }; }));
    const s = await run(w);
    expect(got?.address).toBe(w.holder.address);
    expect(got?.press).toEqual(expect.any(String));
    expect(s.policy_compliant).toBe(true);
    expect(s.notary).toEqual({ warnings: ["notary_key_exposed_later"], derived: { dup_tag: "dGFn" } });
  });
  it("a failure from the hook makes the card non-compliant", async () => {
    const s = await run(world(derivedShape(), cfg(async () => ({ ok: false, code: "NOTARY_KEY_EXPOSED", detail: "x" }))));
    expect(s.policy_compliant).toBe(false);
    expect(s.notary).toBeUndefined();
  });
  it("a hook that finds the press is not a notary card (null) leaves the card as it was", async () => {
    const s = await run(world(derivedShape(), cfg(async () => null)));
    expect(s.policy_compliant).toBe(true);
    expect(s.notary).toBeUndefined();
  });
  it("the hook can ask for a list card's Stages 3-5 verdict through the verifier itself", async () => {
    let trusted: boolean | undefined;
    const w = world(derivedShape(), cfg(async (ctx) => { const k = generateKeypair(); trusted = await ctx.listCardTrusted(k.address, k.publicKey); return null; }));
    await run(w);
    expect(trusted).toBe(false); // an unregistered card is not trusted
  });
});
