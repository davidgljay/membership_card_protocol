/**
 * Watching jobs and resubmitting (wallet_sdk.md §7b.5; notary_replication_and_recovery.md §7).
 *
 * `watchNotaryJobsOnce` is one pass of the watcher. The caller schedules it every 6 hours, and immediately when a
 * validation receipt is still missing 10 minutes after a submission. For each stored input it re-fetches the
 * announcement; on a higher epoch it runs algorithm W, tells the user when the reason was `total_loss`, and
 * re-seals the **stored, already-signed** input to the new job key (not re-signed, no prompt) and submits it.
 * Stored inputs and receipts are kept until a valid notarization has been seen, plus 7 days.
 */
import type { NotaryCountersign, NotaryInput } from "./types.js";
import type { SubmitResult } from "./submit.js";
import type { VerifyJobResult } from "./verifyJob.js";

export interface StoredNotaryInput {
  jobHash: string;
  signed: NotaryInput | NotaryCountersign;
  inputHash: string;
  /** The epoch the input was last sent in. */
  epoch: number;
  submittedAtMs: number;
  hasValidationReceipt: boolean;
  /** Set when a valid notarization for the job has been seen. */
  notarizationSeenAtMs?: number;
}

export interface WatchDeps {
  nowMs(): number;
  list(): Promise<StoredNotaryInput[]>;
  save(s: StoredNotaryInput): Promise<void>;
  remove(jobHash: string, inputHash: string): Promise<void>;
  /** The newest announcement for the job, from any host the wallet can reach; null if none. */
  fetchAnnouncement(jobHash: string): Promise<unknown | null>;
  /** Algorithm W on an announcement, with the highest epoch seen for the job. */
  verify(announcement: unknown, highestEpochSeen: number): Promise<VerifyJobResult>;
  /** Seals the stored signed input to the announcement's key and submits it. */
  resubmit(stored: StoredNotaryInput, verified: Extract<VerifyJobResult, { valid: true }>, announcement: unknown): Promise<SubmitResult>;
  notify(message: string): void;
}

export type WatchAction =
  | { jobHash: string; inputHash: string; action: "resubmitted"; epoch: number; totalLoss: boolean }
  | { jobHash: string; inputHash: string; action: "resubmit_failed"; code: string }
  | { jobHash: string; inputHash: string; action: "announcement_rejected"; code: string }
  | { jobHash: string; inputHash: string; action: "no_change" }
  | { jobHash: string; inputHash: string; action: "pruned" };

export const RECEIPT_WAIT_MS = 10 * 60 * 1000;
export const RETENTION_AFTER_NOTARIZATION_MS = 7 * 24 * 3600 * 1000;

export async function watchNotaryJobsOnce(d: WatchDeps): Promise<WatchAction[]> {
  const out: WatchAction[] = [];
  for (const s of await d.list()) {
    const id = { jobHash: s.jobHash, inputHash: s.inputHash };
    if (s.notarizationSeenAtMs !== undefined) {
      if (d.nowMs() - s.notarizationSeenAtMs >= RETENTION_AFTER_NOTARIZATION_MS) { await d.remove(s.jobHash, s.inputHash); out.push({ ...id, action: "pruned" }); }
      else out.push({ ...id, action: "no_change" });
      continue;
    }
    const ann = await d.fetchAnnouncement(s.jobHash);
    const missingReceipt = !s.hasValidationReceipt && d.nowMs() - s.submittedAtMs >= RECEIPT_WAIT_MS;
    if (ann === null) { out.push({ ...id, action: "no_change" }); continue; }
    const v = await d.verify(ann, s.epoch);
    if (!v.valid) { out.push({ ...id, action: "announcement_rejected", code: v.code }); continue; }
    const newerEpoch = v.epoch > s.epoch;
    if (!newerEpoch && !missingReceipt) { out.push({ ...id, action: "no_change" }); continue; }
    const totalLoss = newerEpoch && (ann as { epoch_reason?: string }).epoch_reason === "total_loss";
    if (totalLoss) d.notify("The notary lost its copies of this job, so your input was sent again automatically.");
    const r = await d.resubmit(s, v, ann);
    if (!r.submitted) { out.push({ ...id, action: "resubmit_failed", code: r.code }); continue; }
    await d.save({ ...s, epoch: v.epoch, submittedAtMs: d.nowMs(), hasValidationReceipt: true });
    out.push({ ...id, action: "resubmitted", epoch: v.epoch, totalLoss });
  }
  return out;
}
