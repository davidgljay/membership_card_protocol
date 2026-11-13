/**
 * Redis keys and retention (notary_host.md §7). The host stores only ciphertexts, receipts and public objects; it
 * never stores a decrypted input, a job key, or the link between a source card and a derived card.
 *
 * | key                                     | value                                   | retention |
 * | `job:{job_hash}`                        | job, latest announcement, epoch, replicas | until finalized/ended + 30 days |
 * | `input:{job_hash}:{epoch}:{input_hash}` | SealedInput bytes, receipt time          | until finalized (aggregate) or the input's run completes (per-input); then DELETED |
 * | `receipt:{input_hash}`                  | HostReceipt                              | 30 days |
 * | `snapshot:{policy_address}`             | policy snapshot and its block            | while any job depends on the policy |
 * | `blob:{notary_card}:{version}`          | encrypted state blob and header          | current and previous version |
 * | `log:{scope_id}`                        | log record CIDs and anchor tx hashes     | permanent |
 */
import type { KvStore } from "../kv.js";

const DAY = 86_400;

export interface StoredJob {
  job: unknown;
  jobHash: string;
  programCid: string;
  announcement: unknown | null;
  epoch: number;
  /** Instance ids (SHA-256(K_inst), base64url) of the live local replicas holding this job. */
  replicas: string[];
  state: "keyed" | "open" | "closing" | "finalized" | "ended" | "aborted";
  logHead: string | null;
}

export interface StoredInput { sealedInput: unknown; receivedAt: string }

export function jobStore(kv: KvStore) {
  return {
    get: (jobHash: string) => kv.getItem<StoredJob>(`job:${jobHash}`),
    /** Every job record still held (live ones and those within their 30-day retention). */
    list: async () => (await kv.getKeys("job:")).map((k) => k.replace(/^job:/, "")),
    put: (j: StoredJob) => kv.setItem(`job:${j.jobHash}`, j),
    /** On finalize or end, the job record stays for 30 days. */
    retire: async (j: StoredJob, state: "finalized" | "ended" | "aborted") => kv.setItem(`job:${j.jobHash}`, { ...j, state }, { ttlSeconds: 30 * DAY }),
  };
}

export function inputStore(kv: KvStore) {
  const key = (jobHash: string, epoch: number, inputHash: string) => `input:${jobHash}:${epoch}:${inputHash}`;
  return {
    put: (jobHash: string, epoch: number, inputHash: string, v: StoredInput) => kv.setItem(key(jobHash, epoch, inputHash), v),
    get: (jobHash: string, epoch: number, inputHash: string) => kv.getItem<StoredInput>(key(jobHash, epoch, inputHash)),
    remove: (jobHash: string, epoch: number, inputHash: string) => kv.removeItem(key(jobHash, epoch, inputHash)),
    list: async (jobHash: string, epoch?: number) => (await kv.getKeys(epoch === undefined ? `input:${jobHash}:` : `input:${jobHash}:${epoch}:`)),
    /** Deletes every stored ciphertext of a job (at finalize). Returns how many were deleted. */
    deleteAll: async (jobHash: string) => { const ks = await kv.getKeys(`input:${jobHash}:`); for (const k of ks) await kv.removeItem(k); return ks.length; },
  };
}

export function receiptStore(kv: KvStore) {
  return {
    put: (inputHash: string, receipt: unknown) => kv.setItem(`receipt:${inputHash}`, receipt, { ttlSeconds: 30 * DAY }),
    get: (inputHash: string) => kv.getItem(`receipt:${inputHash}`),
  };
}

export interface LogEntry { seq: number; record_cid: string; anchor_tx?: string }

export function logStore(kv: KvStore) {
  return {
    list: async (scopeId: string) => (await kv.getItem<LogEntry[]>(`log:${scopeId}`)) ?? [],
    append: async (scopeId: string, e: LogEntry) => { const l = (await kv.getItem<LogEntry[]>(`log:${scopeId}`)) ?? []; await kv.setItem(`log:${scopeId}`, [...l, e]); },
    setAnchor: async (scopeId: string, seq: number, tx: string) => {
      const l = (await kv.getItem<LogEntry[]>(`log:${scopeId}`)) ?? [];
      await kv.setItem(`log:${scopeId}`, l.map((e) => (e.seq === seq ? { ...e, anchor_tx: tx } : e)));
    },
  };
}

export function snapshotStore(kv: KvStore) {
  return {
    get: (policyAddress: string) => kv.getItem(`snapshot:${policyAddress}`),
    put: (policyAddress: string, snapshot: unknown) => kv.setItem(`snapshot:${policyAddress}`, snapshot),
    remove: (policyAddress: string) => kv.removeItem(`snapshot:${policyAddress}`),
  };
}

export function blobStore(kv: KvStore) {
  return {
    /** Keeps the current and the previous version only. */
    put: async (notaryCard: string, version: number, blob: unknown) => {
      await kv.setItem(`blob:${notaryCard}:${version}`, blob);
      for (const k of await kv.getKeys(`blob:${notaryCard}:`)) {
        const v = Number(k.split(":")[2]);
        if (v < version - 1) await kv.removeItem(k);
      }
    },
    get: (notaryCard: string, version: number) => kv.getItem(`blob:${notaryCard}:${version}`),
  };
}
