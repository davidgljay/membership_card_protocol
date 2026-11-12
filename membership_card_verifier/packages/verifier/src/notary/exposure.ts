/**
 * Algorithm E: key exposure (notary_lifecycle.md Appendix A.6; notary_runtime.md §4 key lineage).
 *
 * A notary card's keys (K_id, K_chain) are *exposed* once any runtime image they have lived in is retired as
 * `"vulnerable"`. E finds the moment that happened from public records only:
 *
 * 1. **Lineage.** The PCR0 of the genesis attestation, plus `pcr0_to` of every `identity`-scope handoff record in
 *    the card's identity log. The log is found through its EAS anchors (`anchors(cardAddress)`), and walked to
 *    seq 0: a missing seq, a fork (two different records anchored for one seq), a broken `prev` link, or a record
 *    that fails its checks → `NOTARY_LINEAGE_INCOMPLETE`.
 * 2. **Exposure time** `t_x`: the earliest `retired_at` among lineage entries retired with `retire_reason:
 *    "vulnerable"` on the (algorithm-L-verified) accepted-runtime list. None → not exposed.
 * 3. **Judging an item** dated `t` (which must come from the chain, never from a notary-signed field): `t ≥ t_x`
 *    → rejected; `t < t_x` → warning `notary_key_exposed_later`.
 *
 * Why the log is complete: a receiving enclave doesn't serve until its `handoff` record is anchored, so every
 * enclave that used the keys appears in the anchored log.
 */
import { sha256 } from "@noble/hashes/sha256";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { b64uDecode, b64uEncode, canonicalNotary, cardPointer, digestFromCid, parseCanonicalNotary, parseTimestamp, withoutFields } from "./canonical.js";
import { assertNotaryObject } from "./types.js";
import type { AcceptedRuntime, JobLogRecord } from "./types.js";

export interface ExposureReads {
  /** EAS anchors for the identity log: scope = the notary card address. */
  anchors(cardAddress: string): Promise<{ seq: number; record_cid: string; timestamp: number }[]>;
  fetch(cid: string): Promise<Uint8Array | null>;
}

export type Lineage =
  | { ok: true; pcr0s: Set<string> }
  | { ok: false; code: "NOTARY_LINEAGE_INCOMPLETE"; reason: string };

const verifySig = (pub: string, msg: Uint8Array, sig: string) => {
  try { return ml_dsa44.verify(b64uDecode(sig, 2420), msg, b64uDecode(pub, 1312)); } catch { return false; }
};

/** Step 1: the set of PCR0s (base64url) the card's keys have lived in. */
export async function keyLineage(o: { card: string; kIdPubkey: string; genesisPcr0: Uint8Array; reads: ExposureReads }): Promise<Lineage> {
  const incomplete = (reason: string): Lineage => ({ ok: false, code: "NOTARY_LINEAGE_INCOMPLETE", reason });
  const pcr0s = new Set<string>([b64uEncode(o.genesisPcr0)]);
  const anchors = await o.reads.anchors(o.card);
  const bySeq = new Map<number, Set<string>>();
  for (const a of anchors) { const s = bySeq.get(a.seq) ?? new Set<string>(); s.add(a.record_cid); bySeq.set(a.seq, s); }
  if (bySeq.size === 0) return { ok: true, pcr0s }; // no handoff yet: only the genesis runtime
  const max = Math.max(...bySeq.keys());
  let prevCid: string | undefined;
  for (let seq = 0; seq <= max; seq++) {
    const cids = bySeq.get(seq);
    if (!cids) return incomplete(`gap: no anchored record for seq ${seq}`);
    if (cids.size > 1) return incomplete(`fork: ${cids.size} different records anchored for seq ${seq}`);
    const cid = [...cids][0]!;
    const bytes = await o.reads.fetch(cid);
    if (!bytes) return incomplete(`record ${seq} not available`);
    try { if (b64uEncode(digestFromCid(cid)) !== b64uEncode(sha256(bytes))) return incomplete(`record ${seq} does not match its CID`); } catch { return incomplete(`bad CID at seq ${seq}`); }
    let rec: JobLogRecord;
    try {
      const obj = parseCanonicalNotary(bytes);
      assertNotaryObject(obj, "notary.identity_log.v1");
      rec = obj as unknown as JobLogRecord;
    } catch { return incomplete(`record ${seq} is malformed`); }
    if (rec.seq !== seq || rec.job_hash !== o.card || (seq > 0 ? rec.prev !== prevCid : rec.prev !== undefined)) return incomplete(`record ${seq} is out of sequence`);
    const unsigned = canonicalNotary(withoutFields(rec as unknown as Record<string, unknown>, "notary_signature", "instance_signature"));
    let ok = rec.notary_signature.public_key === o.kIdPubkey && verifySig(o.kIdPubkey, unsigned, rec.notary_signature.signature);
    try { ok = ok && rec.instance === b64uEncode(sha256(b64uDecode(rec.instance_signature.public_key, 1312))) && verifySig(rec.instance_signature.public_key, unsigned, rec.instance_signature.signature); } catch { ok = false; }
    if (!ok) return incomplete(`record ${seq} signatures do not verify`);
    if (rec.kind === "handoff") {
      const body = rec.body as { scope?: string; pcr0_to?: string };
      if (body.scope === "identity" && typeof body.pcr0_to === "string") {
        try { b64uDecode(body.pcr0_to, 48); } catch { return incomplete(`record ${seq} has a malformed pcr0_to`); }
        pcr0s.add(body.pcr0_to);
      }
    }
    prevCid = cid;
  }
  void cardPointer;
  return { ok: true, pcr0s };
}

/** Step 2: the exposure time (ms) — earliest `retired_at` of a lineage runtime retired as vulnerable; undefined if none. */
export function exposureTime(pcr0s: Set<string>, accepted: AcceptedRuntime[]): number | undefined {
  let tx: number | undefined;
  for (const r of accepted) {
    if (r.retire_reason !== "vulnerable" || r.retired_at === undefined || !pcr0s.has(r.pcr0)) continue;
    const t = parseTimestamp(r.retired_at);
    if (tx === undefined || t < tx) tx = t;
  }
  return tx;
}

/** Step 3: judge an item dated `tMs` (a chain time). */
export function judgeItem(tx: number | undefined, tMs: number): "none" | "exposed" | "later" {
  if (tx === undefined) return "none";
  return tMs >= tx ? "exposed" : "later";
}

/** The `keyExposure` read used by algorithms W and N: lineage, then exposure time, then the judgement. */
export function makeKeyExposureRead(o: {
  reads: ExposureReads;
  accepted: AcceptedRuntime[];
  /** The card's K_id (`recipient_pubkey`) and the PCR0 of its genesis attestation (from algorithm G / V). */
  card: (pointer: string) => Promise<{ kIdPubkey: string; genesisPcr0: Uint8Array } | null>;
}): (pointer: string, tMs: number) => Promise<"none" | "exposed" | "later" | "lineage_incomplete"> {
  return async (pointer, tMs) => {
    const c = await o.card(pointer);
    if (!c) return "lineage_incomplete";
    const l = await keyLineage({ card: pointer, kIdPubkey: c.kIdPubkey, genesisPcr0: c.genesisPcr0, reads: o.reads });
    if (!l.ok) return "lineage_incomplete";
    return judgeItem(exposureTime(l.pcr0s, o.accepted), tMs);
  };
}
