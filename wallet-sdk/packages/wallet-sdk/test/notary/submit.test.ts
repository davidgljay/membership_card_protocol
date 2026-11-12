import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha256";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { CipherSuite, HkdfSha256 } from "@hpke/core";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { XWing } from "@hpke/hybridkem-x-wing";
import { b64uDecode, b64uEncode, canonicalNotary, withoutFields } from "@membership-card-protocol/verifier/notary";
import { checkReceipts, receiptAad, sealInput, sealReceipt, sealedInputInfoAad, submitNotaryInput } from "../../src/notary/submit.js";
import type { HostReceipt, NotaryInput, SealedInput, ValidationReceipt } from "../../src/notary/types.js";

const VEC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "notary", "vectors");
const load = (f: string) => JSON.parse(readFileSync(join(VEC, f), "utf8"));
const te = new TextEncoder();
const key = (n: number) => ml_dsa44.keygen(sha256(te.encode(`card-notary-vector-key-${n}`)));
const sign = (n: number, unsigned: object) => ({ public_key: b64uEncode(key(n).publicKey), signature: b64uEncode(ml_dsa44.sign(canonicalNotary(unsigned), key(n).secretKey, { extraEntropy: false })) });
const suite = () => new CipherSuite({ kem: new XWing(), kdf: new HkdfSha256(), aead: new Chacha20Poly1305() });

const xw = load("xwing/js_vectors.json").cases[1];
const JOB_HASH: string = xw.job_hash_b64u, EPOCH: number = xw.epoch;
const JOB_PK: string = xw.pk_b64u;
const input: NotaryInput = load("objects/input.json").cases[0].input;
const plaintext: NotaryInput = { ...input, job_hash: JOB_HASH };

describe("sealing (protocol-objects.md §24)", () => {
  it("info and aad are byte-identical to the interop vectors the Rust runtime reproduces", () => {
    for (const c of load("xwing/js_vectors.json").cases) {
      const { info, aad } = sealedInputInfoAad(c.job_hash_b64u, c.epoch);
      expect(b64uEncode(info), c.id).toBe(c.info_b64u);
      expect(b64uEncode(aad), c.id).toBe(c.aad_b64u);
    }
  });
  it("the broker side (private key) opens what the wallet sealed; the host sees no plaintext; a wrong epoch fails", async () => {
    const s = await sealInput({ plaintext, jobPublicKey: JOB_PK, epoch: EPOCH });
    expect(s.sealed).toMatchObject({ epoch: EPOCH, job_hash: JOB_HASH, kem: "x-wing-draft-06", type: "notary.sealed_input.v1" });
    expect(b64uDecode(s.sealed.enc).length).toBe(1120);
    expect(JSON.stringify(s.sealed)).not.toContain("yes"); // payload choice is not visible
    expect(s.inputHash).toBe(b64uEncode(sha256(canonicalNotary(s.sealed))));
    const st = suite();
    const sk = await st.kem.deserializePrivateKey(b64uDecode(xw.sk_b64u).buffer as ArrayBuffer);
    const { info, aad } = sealedInputInfoAad(JOB_HASH, EPOCH);
    const rctx = await st.createRecipientContext({ recipientKey: sk, enc: b64uDecode(s.sealed.enc), info });
    expect(new TextDecoder().decode(new Uint8Array(await rctx.open(b64uDecode(s.sealed.ct), aad)))).toBe(new TextDecoder().decode(canonicalNotary(plaintext)));
    const other = sealedInputInfoAad(JOB_HASH, EPOCH + 1);
    const r2 = await st.createRecipientContext({ recipientKey: sk, enc: b64uDecode(s.sealed.enc), info: other.info });
    await expect(r2.open(b64uDecode(s.sealed.ct), other.aad)).rejects.toThrow();
  });
  it("the receipt secret is shared with the recipient context (receipt_sealed round trip)", async () => {
    const s = await sealInput({ plaintext, jobPublicKey: JOB_PK, epoch: EPOCH });
    const st = suite();
    const sk = await st.kem.deserializePrivateKey(b64uDecode(xw.sk_b64u).buffer as ArrayBuffer);
    const { info } = sealedInputInfoAad(JOB_HASH, EPOCH);
    const rctx = await st.createRecipientContext({ recipientKey: sk, enc: b64uDecode(s.sealed.enc), info });
    const exportedByEnclave = new Uint8Array(await rctx.export(te.encode("card-notary-receipt-v1"), 32));
    expect(exportedByEnclave).toEqual(s._exportedForTests);
    const receipt = validation(s.inputHash, 2);
    expect(s.openReceipt(sealReceipt(exportedByEnclave, receipt))).toEqual(receipt);
    expect(s.openReceipt(sealReceipt(new Uint8Array(32), receipt))).toBeNull(); // sealed under another key
    expect(receiptAad("a", "b")).toEqual(canonicalNotary({ input_hash: "a", job_hash: "b", type: "notary.validation_receipt.sealed.v1" }));
  });
});

const CARD = "ab".repeat(32);
function validation(inputHash: string, acks: number, over: Partial<ValidationReceipt> = {}): ValidationReceipt {
  const u = { acks, epoch: EPOCH, input_hash: inputHash, instance: b64uEncode(new Uint8Array(32)), job_hash: JOB_HASH, processed_at: "2026-11-12T10:00:00Z", revision: 0, status: "accepted", type: "notary.validation_receipt.v1", ...over };
  return { ...u, notary_signature: sign(1, u) } as unknown as ValidationReceipt;
}
function host(inputHash: string, over: Partial<HostReceipt> = {}): HostReceipt {
  const u = { epoch: EPOCH, input_hash: inputHash, job_hash: JOB_HASH, notary_card: CARD, received_at: "2026-11-12T10:00:00Z", type: "notary.host_receipt.v1", ...over };
  return { ...u, host_signature: sign(3, u) } as unknown as HostReceipt;
}
const jobInfo = { jobHash: JOB_HASH, epoch: EPOCH, jobPublicKey: JOB_PK, quorum: 2, notaryCard: CARD, notaryIdPubkey: b64uEncode(key(1).publicKey), operatorHostPubkey: b64uEncode(key(3).publicKey) };

/** An "enclave + host" that answers a sealed input the way the real ones do. */
async function respond(sealed: SealedInput, o: { acks?: number; vOver?: Partial<ValidationReceipt>; hOver?: Partial<HostReceipt>; corrupt?: boolean } = {}) {
  const st = suite();
  const sk = await st.kem.deserializePrivateKey(b64uDecode(xw.sk_b64u).buffer as ArrayBuffer);
  const { info } = sealedInputInfoAad(sealed.job_hash, sealed.epoch);
  const rctx = await st.createRecipientContext({ recipientKey: sk, enc: b64uDecode(sealed.enc), info });
  const exported = new Uint8Array(await rctx.export(te.encode("card-notary-receipt-v1"), 32));
  const inputHash = b64uEncode(sha256(canonicalNotary(sealed)));
  let sealedReceipt = sealReceipt(exported, validation(inputHash, o.acks ?? 2, o.vOver));
  if (o.corrupt) sealedReceipt = sealedReceipt.slice(0, -4) + "AAAA";
  return { host_receipt: host(inputHash, o.hOver), receipt_sealed: sealedReceipt };
}

describe("submitNotaryInput (wallet_sdk.md §7b.4)", () => {
  const base = (send: (s: SealedInput) => Promise<{ host_receipt: HostReceipt; receipt_sealed: string }>, log: string[] = []) => ({
    job: jobInfo, buildSignedInput: async () => plaintext, send,
    persist: async () => { log.push("persist"); },
  });
  it("persists the signed input BEFORE sending, then returns both verified receipts", async () => {
    const log: string[] = [];
    const r = await submitNotaryInput({ ...base(async (s) => { log.push("send"); return respond(s); }, log) });
    expect(log).toEqual(["persist", "send"]);
    expect(r.submitted).toBe(true);
    if (r.submitted) { expect(r.validationReceipt.acks).toBe(2); expect(r.hostReceipt.notary_card).toBe(CARD); }
  });
  it("a transport failure leaves the input persisted and reports NOTARY_NO_RECEIPT", async () => {
    const log: string[] = [];
    const r = await submitNotaryInput({ ...base(async () => { log.push("send"); throw new Error("relay down"); }, log) });
    expect(log).toEqual(["persist", "send"]);
    expect(r).toMatchObject({ submitted: false, code: "NOTARY_NO_RECEIPT" });
  });
  const bad = async (o: Parameters<typeof respond>[1], reason: RegExp) => {
    const r = await submitNotaryInput({ ...base((s) => respond(s, o)) });
    expect(r).toMatchObject({ submitted: false, code: "NOTARY_NO_RECEIPT" });
    if (!r.submitted) expect(r.reason).toMatch(reason);
  };
  it("rejects a corrupted sealed receipt", () => bad({ corrupt: true }, /could not be opened/));
  it("rejects fewer than q acks", () => bad({ acks: 1 }, /below quorum/));
  it("rejects a host receipt for a different input", () => bad({ hOver: { input_hash: b64uEncode(new Uint8Array(32)) } }, /different input/));
  it("rejects a host receipt signed by someone other than operator_host_pubkey", async () => {
    const r = await submitNotaryInput({ ...base(async (s) => { const x = await respond(s); const forged = { ...withoutFields(x.host_receipt as never, "host_signature"), host_signature: sign(9, { x: 1 }) }; return { ...x, host_receipt: forged as never }; }) });
    expect(r).toMatchObject({ submitted: false, code: "NOTARY_NO_RECEIPT" });
  });
  it("rejects a validation receipt signed by a key other than the notary's K_id", () => bad({ vOver: { notary_signature: sign(9, { y: 1 }) } as never }, /signature invalid/));
  it("reports the notary's reject reason for a rejected input", async () => {
    const r = await submitNotaryInput({ ...base((s) => respond(s, { vOver: { status: "rejected", reject_reason: "INPUT_NOT_ELIGIBLE" } })) });
    expect(r).toMatchObject({ submitted: false, code: "INPUT_NOT_ELIGIBLE" });
  });
  it("checkReceipts binds epoch and job", () => {
    const ih = "x";
    const base2 = { operatorHostPubkey: jobInfo.operatorHostPubkey, notaryIdPubkey: jobInfo.notaryIdPubkey, notaryCard: CARD, inputHash: ih, jobHash: JOB_HASH, epoch: EPOCH, quorum: 2 };
    expect(checkReceipts({ ...base2, hostReceipt: host(ih), validationReceipt: validation(ih, 2) }).ok).toBe(true);
    expect(checkReceipts({ ...base2, epoch: EPOCH + 1, hostReceipt: host(ih), validationReceipt: validation(ih, 2) }).ok).toBe(false);
  });
});
