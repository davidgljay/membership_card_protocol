/**
 * Input submission (wallet_sdk.md §7b.4; protocol-objects.md §23–§26; notary_lifecycle.md Phase 5).
 *
 * Sealing: HPKE base mode, KEM X-Wing draft-06, KDF HKDF-SHA256, AEAD ChaCha20-Poly1305, with the `info`
 * and `aad` of §24. The validation receipt comes back as `receipt_sealed`: ChaCha20-Poly1305 under
 * `Export("card-notary-receipt-v1", 32)` from the inner context, 12-byte all-zero nonce (single-use key),
 * aad = RFC 8785 `{ input_hash, job_hash, type: "notary.validation_receipt.sealed.v1" }` (erratum E7, decided).
 *
 * `submitNotaryInput` orchestrates through injected collaborators: the contributor's sub-card signer, durable
 * storage (the signed input is persisted **before** sending), and the transport (oblivious envelope + relay,
 * wired in Phase 7). Interop with the Rust runtime is proven by notary/vectors/xwing.
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { CipherSuite, HkdfSha256 } from "@hpke/core";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { XWing } from "@hpke/hybridkem-x-wing";
import { mlDsa44Verify } from "@membership-card-protocol/verifier";
import { b64uDecode, b64uEncode, canonicalNotary, H, withoutFields } from "@membership-card-protocol/verifier/notary";
import type { HostReceipt, NotaryCountersign, NotaryInput, SealedInput, SignatureEntry, ValidationReceipt } from "./types.js";

const te = new TextEncoder();
export const RECEIPT_EXPORT_CONTEXT = "card-notary-receipt-v1";
const KEM = "x-wing-draft-06";
const MAX_SEALED_INPUT_BYTES = 256 * 1024;

const suite = () => new CipherSuite({ kem: new XWing(), kdf: new HkdfSha256(), aead: new Chacha20Poly1305() });

/** `info` and `aad` exactly as protocol-objects.md §24 defines them. */
export function sealedInputInfoAad(jobHashB64: string, epoch: number): { info: Uint8Array; aad: Uint8Array } {
  const jobHash = b64uDecode(jobHashB64, 32);
  const epochBytes = new Uint8Array(8);
  new DataView(epochBytes.buffer).setBigUint64(0, BigInt(epoch), false);
  const info = Uint8Array.from([...te.encode("card-notary-input-v1"), 0, ...jobHash, ...epochBytes, ...te.encode(KEM)]);
  const aad = canonicalNotary({ epoch, job_hash: jobHashB64, kem: KEM, type: "notary.sealed_input.v1" });
  return { info, aad };
}

export function receiptAad(inputHashB64: string, jobHashB64: string): Uint8Array {
  return canonicalNotary({ input_hash: inputHashB64, job_hash: jobHashB64, type: "notary.validation_receipt.sealed.v1" });
}

export interface Sealed {
  sealed: SealedInput;
  /** H(SealedInput): identifies the input in receipts and in the input commitment. */
  inputHash: string;
  /** Opens the host's `receipt_sealed` (the exported secret never leaves this closure). */
  openReceipt(receiptSealedB64: string): ValidationReceipt | null;
  /** The exported receipt secret: exposed only so tests can play the enclave. */
  _exportedForTests: Uint8Array;
}

/** Seals a signed `NotaryInput` or `NotaryCountersign` to the job key for an epoch. `ekm` pins the 64 encapsulation bytes (tests only). */
export async function sealInput(o: { plaintext: NotaryInput | NotaryCountersign; jobPublicKey: string; epoch: number; ekm?: Uint8Array }): Promise<Sealed> {
  const jobHash = o.plaintext.job_hash;
  const { info, aad } = sealedInputInfoAad(jobHash, o.epoch);
  const s = suite();
  const pk = await s.kem.deserializePublicKey(b64uDecode(o.jobPublicKey, 1216).buffer as ArrayBuffer);
  const ctx = await s.createSenderContext({ recipientPublicKey: pk, info, ...(o.ekm ? { ekm: o.ekm } : {}) });
  const ct = new Uint8Array(await ctx.seal(canonicalNotary(o.plaintext), aad));
  const sealed: SealedInput = { ct: b64uEncode(ct), enc: b64uEncode(new Uint8Array(ctx.enc)), epoch: o.epoch, job_hash: jobHash, kem: KEM, type: "notary.sealed_input.v1" };
  if (canonicalNotary(sealed).length > MAX_SEALED_INPUT_BYTES) throw new Error("SealedInput exceeds 256 KiB");
  const inputHash = H(sealed);
  const exported = new Uint8Array(await ctx.export(te.encode(RECEIPT_EXPORT_CONTEXT), 32));
  return {
    sealed, inputHash, _exportedForTests: exported,
    openReceipt(b64: string) {
      try {
        const plain = chacha20poly1305(exported, new Uint8Array(12), receiptAad(inputHash, jobHash)).decrypt(b64uDecode(b64));
        return JSON.parse(new TextDecoder().decode(plain)) as ValidationReceipt;
      } catch { return null; }
    },
  };
}

/** The sealed form of a validation receipt, as the enclave produces it (used by tests playing the enclave). */
export function sealReceipt(exported: Uint8Array, receipt: ValidationReceipt): string {
  return b64uEncode(chacha20poly1305(exported, new Uint8Array(12), receiptAad(receipt.input_hash, receipt.job_hash)).encrypt(canonicalNotary(receipt)));
}

export type ReceiptCheck = { ok: true } | { ok: false; reason: string };

/** Checks both receipts (notary_lifecycle.md step 34): signatures, binding to this input, quorum acks. */
export function checkReceipts(o: {
  hostReceipt: HostReceipt; validationReceipt: ValidationReceipt;
  operatorHostPubkey: string; notaryIdPubkey: string; notaryCard: string;
  inputHash: string; jobHash: string; epoch: number; quorum: number;
}): ReceiptCheck {
  const { hostReceipt: h, validationReceipt: v } = o;
  const sigOk = (sig: SignatureEntry, key: string, obj: object, field: string) => {
    try {
      return sig.public_key === key && mlDsa44Verify(b64uDecode(key, 1312), canonicalNotary(withoutFields(obj as Record<string, unknown>, field)), b64uDecode(sig.signature, 2420));
    } catch { return false; }
  };
  if (h.type !== "notary.host_receipt.v1" || !sigOk(h.host_signature, o.operatorHostPubkey, h, "host_signature")) return { ok: false, reason: "host receipt signature invalid" };
  if (h.input_hash !== o.inputHash || h.job_hash !== o.jobHash || h.epoch !== o.epoch || h.notary_card !== o.notaryCard) return { ok: false, reason: "host receipt is for a different input" };
  if (v.type !== "notary.validation_receipt.v1" || !sigOk(v.notary_signature, o.notaryIdPubkey, v, "notary_signature")) return { ok: false, reason: "validation receipt signature invalid" };
  if (v.input_hash !== o.inputHash || v.job_hash !== o.jobHash || v.epoch !== o.epoch) return { ok: false, reason: "validation receipt is for a different input" };
  if (v.acks < o.quorum) return { ok: false, reason: `acks ${v.acks} below quorum ${o.quorum}` };
  return { ok: true };
}

export type SubmitResult =
  | { submitted: true; inputHash: string; hostReceipt: HostReceipt; validationReceipt: ValidationReceipt }
  | { submitted: false; code: string; reason: string };

export interface SubmitOptions {
  /** The verified announcement's fields (after `verifyNotaryJob`). */
  job: { jobHash: string; epoch: number; jobPublicKey: string; quorum: number; notaryCard: string; notaryIdPubkey: string; operatorHostPubkey: string };
  /** Builds and signs the `NotaryInput` with the contributor's `notary_input` sub-card. */
  buildSignedInput(): Promise<NotaryInput | NotaryCountersign>;
  /** Persists the signed input before anything is sent (persist-before-send). */
  persist(signed: NotaryInput | NotaryCountersign, inputHash: string): Promise<void>;
  /** Sends the sealed input through the oblivious transport; resolves with the host's response body. */
  send(sealed: SealedInput): Promise<{ host_receipt: HostReceipt; receipt_sealed: string }>;
}

export async function submitNotaryInput(o: SubmitOptions): Promise<SubmitResult> {
  const signed = await o.buildSignedInput();
  const { sealed, inputHash, openReceipt } = await sealInput({ plaintext: signed, jobPublicKey: o.job.jobPublicKey, epoch: o.job.epoch });
  await o.persist(signed, inputHash);
  let resp: { host_receipt: HostReceipt; receipt_sealed: string };
  try { resp = await o.send(sealed); } catch (e) { return { submitted: false, code: "NOTARY_NO_RECEIPT", reason: String((e as Error).message) }; }
  const validation = openReceipt(resp.receipt_sealed);
  if (!validation) return { submitted: false, code: "NOTARY_NO_RECEIPT", reason: "receipt_sealed could not be opened" };
  const check = checkReceipts({ hostReceipt: resp.host_receipt, validationReceipt: validation, operatorHostPubkey: o.job.operatorHostPubkey, notaryIdPubkey: o.job.notaryIdPubkey,
    notaryCard: o.job.notaryCard, inputHash, jobHash: o.job.jobHash, epoch: o.job.epoch, quorum: o.job.quorum });
  if (!check.ok) return { submitted: false, code: "NOTARY_NO_RECEIPT", reason: check.reason };
  if (validation.status === "rejected") return { submitted: false, code: validation.reject_reason ?? "INPUT_REJECTED", reason: "the notary rejected the input" };
  return { submitted: true, inputHash, hostReceipt: resp.host_receipt, validationReceipt: validation };
}

/**
 * Submits, and retries while the notary says `INPUT_CHAIN_REF_UNKNOWN` (lifecycle Appendix B, B3). The enclave does not
 * wait for a header it has not been sent; the host streams headers about once a second, so a short delay is enough.
 * Every attempt builds and persists its input again, so the wallet's stored copy is the one last sent.
 */
export async function submitNotaryInputWithRetry(o: SubmitOptions, retry: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<SubmitResult> {
  const attempts = retry.attempts ?? 20, delayMs = retry.delayMs ?? 1000;
  const sleep = retry.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let r = await submitNotaryInput(o);
  for (let i = 1; i < attempts && !r.submitted && r.code === "INPUT_CHAIN_REF_UNKNOWN"; i++) {
    await sleep(delayMs);
    r = await submitNotaryInput(o);
  }
  return r;
}
