/**
 * Consent model (wallet_sdk.md §7b.3; notary_lifecycle.md step 25). Built **only** from the policy (at its
 * current head) and the job's signed fields. `requester_text` is carried in its own field and never merged
 * into any other.
 */
import type { AllowlistedProgram, FieldDefinition, NotarySection } from "@membership-card-protocol/verifier/notary";
import type { NotaryJob } from "./types.js";

export interface NotaryConsent {
  collects: FieldDefinition[];
  program: { allowlisted: true; name: string; version: string; auditReport: string } | { allowlisted: false; label: string };
  recipients: { public: boolean; jobRequester: boolean; cards: string[] };
  privacy: { kMin: number; transforms: Record<string, Record<string, unknown>> };
  notaries: { notaryCard: string; operatorCard: string; platform: string }[];
  closesAt?: string;
  endsAt?: string;
  /** Lines the contributor sees before consenting. Built from policy fields only. */
  disclosures: string[];
  /** Shown only inside a box labelled as the requester's own words. */
  requesterText?: string;
}

export const CUSTOM_PROGRAM_LABEL = "custom program — not independently audited";
export const PARTICIPATION_DISCLOSURE = "The operator will learn that your card took part.";

const TRANSFORM_KEYS = ["clamp", "round_to", "buckets", "suppress_cell_below_k"] as const;

function hasSnapshotablePolicy(pred: unknown): boolean {
  if (typeof pred !== "object" || pred === null) return false;
  const p = pred as Record<string, unknown>;
  if ("issued_under_template" in p) return true;
  return Object.values(p).some((v) => (Array.isArray(v) ? v.some(hasSnapshotablePolicy) : hasSnapshotablePolicy(v)));
}

export function buildConsent(o: {
  job: NotaryJob;
  notary: NotarySection;
  allowlisted: AllowlistedProgram | undefined;
  notaries: { notaryCard: string }[];
  operatorCards: Record<string, string>;
  platform: string;
}): NotaryConsent {
  const { job, notary } = o;
  const transforms: Record<string, Record<string, unknown>> = {};
  for (const f of notary.output_schema) {
    const t: Record<string, unknown> = {};
    for (const k of TRANSFORM_KEYS) if (f[k] !== undefined) t[k] = f[k];
    if (Object.keys(t).length > 0) transforms[f["name"] as string] = t;
  }
  const disclosures: string[] = [];
  if (!hasSnapshotablePolicy(notary.contributor_predicate)) disclosures.push(PARTICIPATION_DISCLOSURE);
  if (notary.output_action === "card" && notary.derived_card && notary.revocation_propagation) {
    const d = notary.derived_card, r = notary.revocation_propagation;
    const source = String(job.parameters["source_policy"] ?? "the source");
    if (r.mode === "expiry_only") disclosures.push(`This card lasts until the end of its period. If your ${source} card is revoked, this card won't be renewed.`);
    if (r.mode === "sealed_link")
      disclosures.push(`The notary keeps a sealed link between this card and your ${source} card, so it can revoke this card if that one is revoked. The link is held only inside the secure enclave and is lost if every copy of the notary fails. In small communities, the timing of a revocation may hint at the link.`);
    disclosures.push(`Cards are issued in batches every ${d.issuance_batch_interval ?? "PT6H"}, and only once at least ${d.min_anonymity_set ?? 10} people share the same values. Yours may take longer.`);
    disclosures.push(`Anyone who sees this card learns: ${source}, the requested field names and values, the issuing notary, and the expiry date.`);
  }
  const rec = notary.output_recipients ?? { cards: [], job_requester: false, public: false };
  return {
    collects: notary.input_schema,
    program: o.allowlisted
      ? { allowlisted: true, name: o.allowlisted.name, version: o.allowlisted.version, auditReport: o.allowlisted.audit_report_cid }
      : { allowlisted: false, label: CUSTOM_PROGRAM_LABEL },
    recipients: { public: rec.public, jobRequester: rec.job_requester, cards: rec.cards },
    privacy: { kMin: notary.privacy.k_min, transforms },
    notaries: o.notaries.map((n) => ({ notaryCard: n.notaryCard, operatorCard: o.operatorCards[n.notaryCard] ?? "", platform: o.platform })),
    ...(job.closes_at ? { closesAt: job.closes_at } : {}),
    ...(job.ends_at ? { endsAt: job.ends_at } : {}),
    disclosures,
    ...(job.requester_text !== undefined ? { requesterText: job.requester_text } : {}),
  };
}
