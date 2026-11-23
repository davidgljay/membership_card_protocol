import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha256";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { CipherSuite, HkdfSha256 } from "@hpke/core";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { XWing } from "@hpke/hybridkem-x-wing";
import { keccak256, mlDsa44Verify } from "@membership-card-protocol/app-sdk";
import { b64uDecode, b64uEncode, canonicalNotary, H } from "@membership-card-protocol/verifier/notary";
import { sealReceipt, sealedInputInfoAad } from "../../src/notary/submit.js";
import { advanceDerivedCard, checkDerivedOffer, NOT_ISSUED_MESSAGE, renewDerivedCards, requestDerivedCard, type DerivedConsent, type DerivedKeypair } from "../../src/notary/derived.js";
import type { HostReceipt, NotaryCountersign, NotaryInput, SealedInput, ValidationReceipt } from "../../src/notary/types.js";

const VEC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "notary", "vectors");
const load = (f: string) => JSON.parse(readFileSync(join(VEC, f), "utf8"));
const te = new TextEncoder();
const key = (n: number) => ml_dsa44.keygen(sha256(te.encode(`card-notary-vector-key-${n}`)));
const sign = (n: number, unsigned: object) => ({ public_key: b64uEncode(key(n).publicKey), signature: b64uEncode(ml_dsa44.sign(canonicalNotary(unsigned), key(n).secretKey, { extraEntropy: false })) });
const suite = () => new CipherSuite({ kem: new XWing(), kdf: new HkdfSha256(), aead: new Chacha20Poly1305() });

const xw = load("xwing/js_vectors.json").cases[1];
const JOB_HASH: string = xw.job_hash_b64u, EPOCH: number = xw.epoch, JOB_PK: string = xw.pk_b64u;
const CARD = "ab".repeat(32);
const jobInfo = { jobHash: JOB_HASH, epoch: EPOCH, jobPublicKey: JOB_PK, quorum: 1, notaryCard: CARD, notaryIdPubkey: b64uEncode(key(1).publicKey), operatorHostPubkey: b64uEncode(key(3).publicKey) };
const baseInput: NotaryInput = { ...load("objects/input.json").cases[0].input, job_hash: JOB_HASH };

const TEMPLATE = "t".repeat(10), SOURCE_POLICY = "s".repeat(10);
const FIELDS = { rank: "gold", city: "Oslo", secret: "x" };
const consent = (over: Partial<DerivedConsent> = {}): DerivedConsent => ({ template: TEMPLATE, sourcePolicy: SOURCE_POLICY, projectedFields: ["rank"], expiresAt: "2026-12-01T00:00:00Z", ...over });
const projectedOf = (o: Record<string, unknown>) => new TextDecoder().decode(canonicalNotary(o));

/** An offer as the enclave builds it (protocol-objects §2.2), signed by K_id (= key 1 here). */
function offer(over: Record<string, unknown> = {}, signer = 1): Record<string, unknown> {
  const u = { ancestry_pubkeys: [], dup_tag: b64uEncode(new Uint8Array(32)), expires_at: "2026-12-01T00:00:00Z", issued_at: "2026-11-24T06:00:00Z", issuer_card: CARD, policy_id: TEMPLATE,
    press_card: CARD, projected: projectedOf({ rank: "gold" }), source_policy: SOURCE_POLICY, ...over };
  return { ...u, issuer_signature: sign(signer, u).signature };
}

/** The "enclave and host": opens a sealed message, records it, and answers with receipts (the offer for a request, none for a countersign). */
function enclave(offers: () => Record<string, unknown> | undefined, over: Partial<ValidationReceipt> = {}) {
  const opened: (NotaryInput | NotaryCountersign)[] = [];
  const send = async (sealed: SealedInput) => {
    const st = suite();
    const sk = await st.kem.deserializePrivateKey(b64uDecode(xw.sk_b64u).buffer as ArrayBuffer);
    const { info, aad } = sealedInputInfoAad(sealed.job_hash, sealed.epoch);
    const rctx = await st.createRecipientContext({ recipientKey: sk, enc: b64uDecode(sealed.enc), info });
    const plain = JSON.parse(new TextDecoder().decode(new Uint8Array(await rctx.open(b64uDecode(sealed.ct), aad))));
    opened.push(plain);
    const exported = new Uint8Array(await rctx.export(te.encode("card-notary-receipt-v1"), 32));
    const inputHash = b64uEncode(sha256(canonicalNotary(sealed)));
    const o = plain.type === "notary.input.v1" ? offers() : undefined;
    const v = { acks: 1, ...(o ? { derived_offer: o } : {}), epoch: EPOCH, input_hash: inputHash, instance: b64uEncode(new Uint8Array(32)), job_hash: JOB_HASH, processed_at: "2026-11-24T05:00:00Z", revision: 0, status: "accepted", type: "notary.validation_receipt.v1", ...over };
    const hu = { epoch: EPOCH, input_hash: inputHash, job_hash: JOB_HASH, notary_card: CARD, received_at: "2026-11-24T05:00:00Z", type: "notary.host_receipt.v1" };
    return { host_receipt: { ...hu, host_signature: sign(3, hu) } as unknown as HostReceipt, receipt_sealed: sealReceipt(exported, { ...v, notary_signature: sign(1, v) } as unknown as ValidationReceipt) };
  };
  return { send, opened };
}

function run(o: { offers?: () => Record<string, unknown> | undefined; vOver?: Partial<ValidationReceipt>; consent?: DerivedConsent; log?: string[] } = {}) {
  const log = o.log ?? [];
  const keyPair = ml_dsa44.keygen(sha256(te.encode("derived-key-under-test")));
  const d: DerivedKeypair = { publicKey: keyPair.publicKey, secretKey: keyPair.secretKey };
  const e = enclave(o.offers ?? (() => offer()), o.vOver);
  const opts = {
    job: jobInfo, consent: o.consent ?? consent(), sourceFields: FIELDS, targetPeriod: 7, newKey: () => d,
    keys: { persistNewKey: async () => { log.push("persist-key"); } },
    buildSignedInput: async (payload: { derived_recipient_pubkey: string; target_period: number }) => { log.push("sign-input"); return { ...baseInput, payload }; },
    persist: async () => { log.push("persist"); },
    send: async (s: SealedInput) => { log.push("send"); return e.send(s); },
  };
  return { opts, e, d, log };
}

describe("requestDerivedCard (wallet_sdk.md §7b.7, propagation §3 steps 1–5)", () => {
  it("persists the key before anything is signed, countersigns the offer with D, and returns the address", async () => {
    const t = run();
    const r = await requestDerivedCard(t.opts);
    expect(t.log).toEqual(["persist-key", "sign-input", "persist", "send", "persist", "send"]);
    expect(r).toMatchObject({ pending: true, derivedAddress: keccak256(t.d.publicKey), expiresAt: "2026-12-01T00:00:00Z", issuedAtBoundary: "2026-11-24T06:00:00Z" });
    // what the enclave received: the request, then a countersign over the offer plus D_pub, signed by D
    const [req, cs] = t.e.opened as [NotaryInput, NotaryCountersign];
    expect(req.payload).toEqual({ derived_recipient_pubkey: b64uEncode(t.d.publicKey), target_period: 7 });
    expect(cs.type).toBe("notary.countersign.v1");
    const o = offer();
    expect(cs.offer_hash).toBe(H(o));
    expect(mlDsa44Verify(t.d.publicKey, canonicalNotary({ ...o, recipient_pubkey: b64uEncode(t.d.publicKey) }), b64uDecode(cs.holder_signature, 2420))).toBe(true);
  });
  it("a bare membership claim expects projected to be {}", async () => {
    const t = run({ consent: consent({ projectedFields: [] }), offers: () => offer({ projected: "{}" }) });
    expect(await requestDerivedCard(t.opts)).toMatchObject({ pending: true });
    const t2 = run({ consent: consent({ projectedFields: [] }) }); // the offer copies a field the holder did not consent to
    expect(await requestDerivedCard(t2.opts)).toMatchObject({ pending: false, code: "DERIVE_OFFER_INVALID" });
  });
  // Each way an offer can differ from what was consented to: refused, and NO countersign is sent (mutation check:
  // removing a clause of checkDerivedOffer makes the matching case below pass the offer and send a countersign).
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["a projected value that is not the holder's own", { projected: projectedOf({ rank: "platinum" }) }, /projected/],
    ["an extra projected field", { projected: projectedOf({ city: "Oslo", rank: "gold" }) }, /projected/],
    ["another template", { policy_id: "u".repeat(10) }, /policy_id/],
    ["another source policy", { source_policy: "z".repeat(10) }, /source_policy/],
    ["another issuer card", { issuer_card: "cd".repeat(32) }, /notary/],
    ["another press card", { press_card: "cd".repeat(32) }, /notary/],
    ["another expiry", { expires_at: "2027-01-01T00:00:00Z" }, /expires_at/],
  ];
  for (const [name, over, why] of cases) {
    it(`refuses ${name}, without countersigning`, async () => {
      const t = run({ offers: () => offer(over) });
      const r = await requestDerivedCard(t.opts);
      expect(r).toMatchObject({ pending: false, code: "DERIVE_OFFER_INVALID" });
      if (!r.pending) expect(r.reason).toMatch(why);
      expect(t.e.opened.length).toBe(1); // only the request went out
    });
  }
  it("refuses an offer not signed by the notary card's key, and one that was altered after signing", async () => {
    const forged = run({ offers: () => offer({}, 9) });
    expect(await requestDerivedCard(forged.opts)).toMatchObject({ pending: false, code: "DERIVE_OFFER_INVALID" });
    expect(forged.e.opened.length).toBe(1);
    const altered = run({ offers: () => ({ ...offer(), dup_tag: b64uEncode(new Uint8Array(32).fill(1)) }) });
    expect(await requestDerivedCard(altered.opts)).toMatchObject({ pending: false, code: "DERIVE_OFFER_INVALID" });
  });
  it("a missing offer, and a refusal in the receipt, are reported with the notary's code", async () => {
    expect(await requestDerivedCard(run({ offers: () => undefined }).opts)).toMatchObject({ pending: false, code: "DERIVE_OFFER_MISSING" });
    expect(await requestDerivedCard(run({ vOver: { status: "rejected", reject_reason: "DERIVE_DUPLICATE" } }).opts)).toMatchObject({ pending: false, code: "DERIVE_DUPLICATE" });
  });
  it("a refused countersign is reported", async () => {
    const t = run();
    const send = t.opts.send;
    let n = 0;
    const r = await requestDerivedCard({ ...t.opts, send: async (s) => { const x = await send(s); if (++n === 2) throw new Error("relay down"); return x; } });
    expect(r).toMatchObject({ pending: false, code: "NOTARY_NO_RECEIPT" });
  });
  it("checkDerivedOffer accepts the honest offer (negative control)", () => {
    expect(checkDerivedOffer({ offer: offer(), consent: consent(), sourceFields: FIELDS, notaryCard: CARD, notaryIdPubkey: jobInfo.notaryIdPubkey })).toEqual({ ok: true });
  });
});

describe("advanceDerivedCard (steps 5, 8, 10)", () => {
  const base = (nowMs: number, over: Record<string, unknown> = {}) => {
    const t = run({ offers: () => offer({ issued_at: "2026-11-24T12:00:00Z" }) });
    return { t, a: { nowMs, job: jobInfo, consent: consent(), sourceFields: FIELDS, derivedKey: t.d, issuedAtBoundary: "2026-11-24T06:00:00Z", expiresAt: "2026-12-01T00:00:00Z",
      isRegistered: async () => false, resubmitRequest: () => resubmit(t),
      persist: t.opts.persist, send: t.opts.send, ...over } };
  };
  // the stored request is resubmitted: the enclave answers with a fresh offer for the next boundary
  async function resubmit(t: ReturnType<typeof run>) {
    const { submitNotaryInput } = await import("../../src/notary/submit.js");
    return submitNotaryInput({ job: jobInfo, buildSignedInput: async () => ({ ...baseInput, payload: { derived_recipient_pubkey: b64uEncode(t.d.publicKey), target_period: 7 } }), persist: t.opts.persist, send: t.opts.send });
  }
  const at = (s: string) => Date.parse(s);
  it("a registered card ends the wait", async () => {
    const { t, a } = base(at("2026-11-24T07:00:00Z"), { isRegistered: async (addr: string) => addr === keccak256(run().d.publicKey) });
    expect(await advanceDerivedCard(a)).toMatchObject({ state: "registered" });
    expect(t.e.opened.length).toBe(0);
  });
  it("before the boundary it waits and sends nothing", async () => {
    const { t, a } = base(at("2026-11-24T05:59:00Z"));
    expect(await advanceDerivedCard(a)).toEqual({ state: "waiting", issuedAtBoundary: "2026-11-24T06:00:00Z" });
    expect(t.e.opened.length).toBe(0);
  });
  it("after the boundary it resubmits and countersigns the new offer, with no prompt", async () => {
    const { t, a } = base(at("2026-11-24T06:01:00Z"));
    const r = await advanceDerivedCard(a);
    expect(r).toMatchObject({ state: "re_offered", issuedAtBoundary: "2026-11-24T12:00:00Z" });
    const cs = t.e.opened[1] as NotaryCountersign;
    expect(cs.offer_hash).toBe(H(offer({ issued_at: "2026-11-24T12:00:00Z" })));
  });
  it("a re-offer that does not match what was consented to is not countersigned", async () => {
    const t = run({ offers: () => offer({ projected: projectedOf({ rank: "bronze" }), issued_at: "2026-11-24T12:00:00Z" }) });
    const r = await advanceDerivedCard({ nowMs: at("2026-11-24T06:01:00Z"), job: jobInfo, consent: consent(), sourceFields: FIELDS, derivedKey: t.d, issuedAtBoundary: "2026-11-24T06:00:00Z",
      expiresAt: "2026-12-01T00:00:00Z", isRegistered: async () => false, resubmitRequest: () => resubmit(t), persist: t.opts.persist, send: t.opts.send });
    expect(r).toMatchObject({ state: "failed", code: "DERIVE_OFFER_INVALID" });
    expect(t.e.opened.length).toBe(1);
  });
  it("a card still pooled when its period ends is reported as not issued, not retried", async () => {
    const { t, a } = base(at("2026-12-01T00:00:01Z"));
    expect(await advanceDerivedCard(a)).toEqual({ state: "not_issued", message: NOT_ISSUED_MESSAGE });
    expect(t.e.opened.length).toBe(0);
  });
});

describe("renewDerivedCards (§1)", () => {
  const P = 7 * 86_400_000, W = 24 * 3_600_000;
  const card = (id: string, expiresAtMs: number, renewalStarted = false) => ({ id, expiresAtMs, renewalStarted });
  it("requests the next period for a card inside its renewal window, once", async () => {
    const exp = 9 * P; // the end of period 8
    const asked: [string, number][] = [];
    const out = await renewDerivedCards({ nowMs: exp - W / 2, periodMs: P, renewalWindowMs: W,
      cards: [card("in-window", exp), card("early", exp + P), card("started", exp, true), card("expired", exp - P)],
      request: async (c, p) => { asked.push([c.id, p]); return { pending: false, code: "X", reason: "stub" }; } });
    expect(asked).toEqual([["in-window", 9]]);
    expect(out.map((o) => o.id)).toEqual(["in-window"]);
  });
  it("the window's first instant counts and its last does not", async () => {
    const exp = 9 * P;
    const ask = (nowMs: number) => renewDerivedCards({ nowMs, periodMs: P, renewalWindowMs: W, cards: [card("c", exp)], request: async () => ({ pending: false, code: "X", reason: "" }) });
    expect((await ask(exp - W)).length).toBe(1);
    expect((await ask(exp - W - 1)).length).toBe(0);
    expect((await ask(exp)).length).toBe(0);
  });
});
