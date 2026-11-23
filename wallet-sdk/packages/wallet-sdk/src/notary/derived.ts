/**
 * Derived cards, the holder's side (wallet_sdk.md §7b.7; derived_card_revocation_propagation.md §3 steps 1–10, §1 renewal).
 *
 * Like `submitNotaryInput`, this module orchestrates through injected collaborators: the source card's signer (inside
 * `buildSignedInput`), durable storage (`persist`, `keys`) and the oblivious transport (`send`). Nothing here reaches
 * the network or storage itself. The round trips are:
 *
 *   1. generate a fresh derived key D and **persist it before anything is signed**;
 *   2. submit the request (a `NotaryInput` whose payload is `{ derived_recipient_pubkey, target_period }`);
 *   3. check the offer in the validation receipt against what the holder consented to, **not** against the offer itself;
 *   4. countersign it with D, with no new prompt, and submit the `NotaryCountersign` the same way;
 *   5. `advanceDerivedCard`: wait for `keccak256(D_pub)` in the registry; after the offer's boundary has passed,
 *      resubmit the stored request and countersign the new offer automatically (step 8);
 *   6. `renewDerivedCards`: during each card's last `renewal_window`, request the next period's card.
 */
import { keccak256, mlDsa44GenerateKeypair, mlDsa44Sign, mlDsa44Verify } from "@membership-card-protocol/app-sdk";
import { b64uDecode, b64uEncode, canonicalNotary, H, withoutFields } from "@membership-card-protocol/verifier/notary";
import { submitNotaryInput, type SubmitOptions, type SubmitResult } from "./submit.js";
import type { NotaryCountersign, NotaryInput, ValidationReceipt } from "./types.js";

export interface DerivedKeypair { publicKey: Uint8Array; secretKey: Uint8Array }

/** What the holder agreed to at step 1. Built from the template and the job, never from the offer being checked. */
export interface DerivedConsent {
  /** The template policy `T`. */
  template: string;
  sourcePolicy: string;
  /** The source field names to copy (`parameters.projected_fields`); empty for a bare membership claim. */
  projectedFields: string[];
  /** `(p + 1) · P` for the target period, as a timestamp. */
  expiresAt: string;
}

export interface RequestDerivedCardOptions {
  /** The verified announcement's fields (after `verifyNotaryJob`). */
  job: SubmitOptions["job"];
  consent: DerivedConsent;
  /** The held source card's values for the projected fields, by source-policy name. */
  sourceFields: Record<string, unknown>;
  targetPeriod: number;
  keys: {
    /** Durably stores the new key, in the backup-recoverable keyring, and resolves only once that is confirmed. */
    persistNewKey(key: DerivedKeypair): Promise<void>;
  };
  /** Builds the `NotaryInput` with this payload and signs it with the source card's `notary_input` sub-card. */
  buildSignedInput(payload: { derived_recipient_pubkey: string; target_period: number }): Promise<NotaryInput>;
  persist: SubmitOptions["persist"];
  send: SubmitOptions["send"];
  /** Tests only: a fixed key. */
  newKey?: () => DerivedKeypair;
}

export type DerivedRequestResult =
  | { pending: true; derivedAddress: string; expiresAt: string; issuedAtBoundary: string; derivedPublicKey: string; inputHash: string; offerHash: string }
  | { pending: false; code: string; reason: string };

export type OfferCheck = { ok: true } | { ok: false; reason: string };

/** The address a derived card is registered under. */
export function derivedAddress(publicKey: Uint8Array): string {
  return keccak256(publicKey);
}

/**
 * Step 5 of §3: the offer is acceptable only if `projected` is the holder's own source values for the consented
 * fields, `expires_at`, `source_policy`, `issuer_card` and `policy_id` are as consented, and `issuer_signature`
 * verifies against the notary card's key. A bare claim expects `projected` to be `"{}"`.
 */
export function checkDerivedOffer(o: { offer: Record<string, unknown>; consent: DerivedConsent; sourceFields: Record<string, unknown>; notaryCard: string; notaryIdPubkey: string }): OfferCheck {
  const { offer, consent } = o;
  const expected: Record<string, unknown> = {};
  for (const f of consent.projectedFields) {
    if (!(f in o.sourceFields)) return { ok: false, reason: `the source card has no field ${f}` };
    expected[f] = o.sourceFields[f];
  }
  if (offer["projected"] !== new TextDecoder().decode(canonicalNotary(expected))) return { ok: false, reason: "projected is not the source card's values for the consented fields" };
  if (offer["policy_id"] !== consent.template) return { ok: false, reason: "policy_id is not the consented template" };
  if (offer["source_policy"] !== consent.sourcePolicy) return { ok: false, reason: "source_policy is not the consented policy" };
  if (offer["issuer_card"] !== o.notaryCard || offer["press_card"] !== o.notaryCard) return { ok: false, reason: "the offer is not issued by the consented notary" };
  if (offer["expires_at"] !== consent.expiresAt) return { ok: false, reason: "expires_at is not the consented expiry" };
  try {
    const sig = b64uDecode(String(offer["issuer_signature"]), 2420);
    if (!mlDsa44Verify(b64uDecode(o.notaryIdPubkey, 1312), canonicalNotary(withoutFields(offer, "issuer_signature")), sig)) return { ok: false, reason: "issuer_signature does not verify against the notary card's key" };
  } catch { return { ok: false, reason: "issuer_signature is malformed" }; }
  return { ok: true };
}

/** `holder_signature` over the offer plus `recipient_pubkey = D_pub`, signed by D; `offer_hash` names the offer as returned. */
export function buildCountersign(o: { offer: Record<string, unknown>; derivedKey: DerivedKeypair; jobHash: string }): NotaryCountersign {
  const signed = { ...o.offer, recipient_pubkey: b64uEncode(o.derivedKey.publicKey) };
  return {
    holder_signature: b64uEncode(mlDsa44Sign(o.derivedKey.secretKey, canonicalNotary(signed))),
    job_hash: o.jobHash,
    offer_hash: H(o.offer),
    type: "notary.countersign.v1",
  };
}

type Fail = { pending: false; code: string; reason: string };
const fail = (code: string, reason: string): Fail => ({ pending: false, code, reason });

/** Steps 3 and 4: check the offer in a validation receipt, countersign it, submit the countersign. */
async function acceptOffer(o: {
  receipt: ValidationReceipt; job: SubmitOptions["job"]; consent: DerivedConsent; sourceFields: Record<string, unknown>;
  derivedKey: DerivedKeypair; persist: SubmitOptions["persist"]; send: SubmitOptions["send"];
}): Promise<{ ok: true; offer: Record<string, unknown>; offerHash: string } | { ok: false; fail: Fail }> {
  const offer = o.receipt.derived_offer;
  if (offer === undefined) return { ok: false, fail: fail("DERIVE_OFFER_MISSING", "the validation receipt carries no derived_offer") };
  const check = checkDerivedOffer({ offer, consent: o.consent, sourceFields: o.sourceFields, notaryCard: o.job.notaryCard, notaryIdPubkey: o.job.notaryIdPubkey });
  if (!check.ok) return { ok: false, fail: fail("DERIVE_OFFER_INVALID", check.reason) };
  const countersign = buildCountersign({ offer, derivedKey: o.derivedKey, jobHash: o.job.jobHash });
  const r = await submitNotaryInput({ job: o.job, buildSignedInput: async () => countersign, persist: o.persist, send: o.send });
  if (!r.submitted) return { ok: false, fail: fail(r.code, r.reason) };
  return { ok: true, offer, offerHash: countersign.offer_hash };
}

/** §7b.7 steps 1–4. The card itself appears later; see `advanceDerivedCard`. */
export async function requestDerivedCard(o: RequestDerivedCardOptions): Promise<DerivedRequestResult> {
  // 1. the key is persisted before any signature (the countersign below, the input's own signing) can use it
  const key = (o.newKey ?? (() => mlDsa44GenerateKeypair()))();
  await o.keys.persistNewKey(key);
  // 2. submit
  const payload = { derived_recipient_pubkey: b64uEncode(key.publicKey), target_period: o.targetPeriod };
  let inputHash = "";
  const r: SubmitResult = await submitNotaryInput({
    job: o.job, buildSignedInput: () => o.buildSignedInput(payload),
    persist: async (signed, h) => { inputHash = h; await o.persist(signed, h); }, send: o.send,
  });
  if (!r.submitted) return fail(r.code, r.reason);
  // 3 and 4
  const a = await acceptOffer({ receipt: r.validationReceipt, job: o.job, consent: o.consent, sourceFields: o.sourceFields, derivedKey: key, persist: o.persist, send: o.send });
  if (!a.ok) return a.fail;
  return {
    pending: true, derivedAddress: derivedAddress(key.publicKey), expiresAt: String(a.offer["expires_at"]), issuedAtBoundary: String(a.offer["issued_at"]),
    derivedPublicKey: b64uEncode(key.publicKey), inputHash, offerHash: a.offerHash,
  };
}

export interface AdvanceDerivedCardOptions {
  nowMs: number;
  job: SubmitOptions["job"];
  consent: DerivedConsent;
  sourceFields: Record<string, unknown>;
  derivedKey: DerivedKeypair;
  /** The offer boundary last countersigned (`issuedAtBoundary`). */
  issuedAtBoundary: string;
  /** The end of the target period, as a timestamp (`expiresAt`). */
  expiresAt: string;
  /** Is `keccak256(D_pub)` in the registry? */
  isRegistered(address: string): Promise<boolean>;
  /** Resubmits the stored, already-signed request and returns its validation receipt (a fresh offer if the old one's boundary passed). */
  resubmitRequest(): Promise<SubmitResult>;
  persist: SubmitOptions["persist"];
  send: SubmitOptions["send"];
}

export type AdvanceDerivedCardResult =
  | { state: "registered"; derivedAddress: string }
  | { state: "waiting"; issuedAtBoundary: string }
  | { state: "re_offered"; issuedAtBoundary: string; offerHash: string }
  | { state: "not_issued"; message: string }
  | { state: "failed"; code: string; reason: string };

export const NOT_ISSUED_MESSAGE = "not issued: too few holders share these values";

/**
 * Steps 5 (wait), 8 (a re-offer is countersigned automatically) and 10 (the period ended with the card still pooled).
 * Call it periodically. It never prompts.
 */
export async function advanceDerivedCard(o: AdvanceDerivedCardOptions): Promise<AdvanceDerivedCardResult> {
  const address = derivedAddress(o.derivedKey.publicKey);
  if (await o.isRegistered(address)) return { state: "registered", derivedAddress: address };
  if (o.nowMs >= Date.parse(o.expiresAt)) return { state: "not_issued", message: NOT_ISSUED_MESSAGE };
  if (o.nowMs < Date.parse(o.issuedAtBoundary)) return { state: "waiting", issuedAtBoundary: o.issuedAtBoundary };
  // the offer's boundary has passed without the card being released: ask again, and countersign what comes back
  const r = await o.resubmitRequest();
  if (!r.submitted) return { state: "failed", code: r.code, reason: r.reason };
  const a = await acceptOffer({ receipt: r.validationReceipt, job: o.job, consent: o.consent, sourceFields: o.sourceFields, derivedKey: o.derivedKey, persist: o.persist, send: o.send });
  if (!a.ok) return { state: "failed", code: a.fail.code, reason: a.fail.reason };
  return { state: "re_offered", issuedAtBoundary: String(a.offer["issued_at"]), offerHash: a.offerHash };
}

export interface HeldDerivedCard {
  /** Which card this is, for the caller's own bookkeeping (a stored-card id or the derived address). */
  id: string;
  /** `expires_at` = `(p + 1) · P`. */
  expiresAtMs: number;
  /** A card for the next period already exists or is in flight. */
  renewalStarted: boolean;
}

export interface RenewDerivedCardsOptions {
  nowMs: number;
  /** `nullifier_period` of the template, in milliseconds. */
  periodMs: number;
  /** `renewal_window`, in milliseconds. */
  renewalWindowMs: number;
  cards: HeldDerivedCard[];
  /** Requests a fresh card for `targetPeriod` (a new key, a new tag): calls `requestDerivedCard`. */
  request(card: HeldDerivedCard, targetPeriod: number): Promise<DerivedRequestResult>;
}

export type RenewalOutcome = { id: string; targetPeriod: number; result: DerivedRequestResult };

/**
 * §1 renewal: in the last `renewal_window` of period `p`, present the source card again for `p + 1`, which gets a
 * fresh card. Cards are never updated in place. A card outside its window, already expired, or already renewed is skipped.
 */
export async function renewDerivedCards(o: RenewDerivedCardsOptions): Promise<RenewalOutcome[]> {
  const out: RenewalOutcome[] = [];
  for (const c of o.cards) {
    if (c.renewalStarted || o.nowMs >= c.expiresAtMs || o.nowMs < c.expiresAtMs - o.renewalWindowMs) continue;
    const targetPeriod = Math.round(c.expiresAtMs / o.periodMs);
    out.push({ id: c.id, targetPeriod, result: await o.request(c, targetPeriod) });
  }
  return out;
}
