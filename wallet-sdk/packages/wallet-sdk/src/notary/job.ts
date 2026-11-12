/**
 * Requesting a job (notary_lifecycle.md Phase 2 steps 14–15; protocol-objects.md §21).
 *
 * Builds a `NotaryJob`, signs it with the requester's card key, computes `job_hash = H(complete job)` and the
 * raw-codec CID it is pinned under (digest = job_hash), and sends `{ job, program_cid }` to each replica host.
 * Whether the policy allows this requester, and whether the parameters fit the bounds, is checked by every
 * wallet (algorithm W) and by the hosts; the local checks here only stop obviously malformed jobs.
 */
import { b64uEncode, canonicalNotary, cardPointer, cidOfBytes, H, NotaryFormatError, parseDuration, parseTimestamp } from "@membership-card-protocol/verifier/notary";
import type { NotaryJob } from "./types.js";

export interface RequesterKey {
  /** ML-DSA-44 public key (1312 bytes). */
  publicKey: Uint8Array;
  /** Signs the canonical bytes (ML-DSA-44, empty context). */
  sign(message: Uint8Array): Promise<Uint8Array> | Uint8Array;
}

export interface BuildJobOptions {
  policyId: string;
  /** The policy's log head when the job is signed. */
  policyStateCid: string;
  replicaSet: { notary_card: string; instances: number }[];
  /** Default: the quorum rounded up to at least 2, capped at N. */
  minLive?: number;
  parameters?: Record<string, unknown>;
  opensAt: string;
  /** Aggregate mode. */
  closesAt?: string;
  /** Per-input mode. */
  endsAt?: string;
  keyPeriod?: string;
  requesterText?: string;
  createdAt: string;
  /** 16 random bytes. */
  nonce: Uint8Array;
  requester: RequesterKey;
}

export interface BuiltJob { job: NotaryJob; jobHash: string; jobBytes: Uint8Array; jobCid: string }

export class JobBuildError extends Error {
  constructor(public readonly code: "JOB_MALFORMED", message: string) { super(`${code}: ${message}`); }
}

export async function buildNotaryJob(o: BuildJobOptions): Promise<BuiltJob> {
  try {
    return await buildNotaryJobUnchecked(o);
  } catch (e) {
    if (e instanceof NotaryFormatError) throw new JobBuildError("JOB_MALFORMED", e.message);
    throw e;
  }
}

async function buildNotaryJobUnchecked(o: BuildJobOptions): Promise<BuiltJob> {
  const bad = (m: string): never => { throw new JobBuildError("JOB_MALFORMED", m); };
  if (o.replicaSet.length === 0 || o.replicaSet.some((r) => !Number.isInteger(r.instances) || r.instances < 1)) bad("replica_set needs at least one card with instances >= 1");
  const n = o.replicaSet.reduce((a, r) => a + r.instances, 0);
  const q = Math.floor(n / 2) + 1;
  const minLive = o.minLive ?? Math.min(n, Math.max(q, 2));
  if (!(q <= minLive && minLive <= n)) bad(`min_live must satisfy q (${q}) <= min_live <= N (${n})`);
  if (o.nonce.length !== 16) bad("nonce must be 16 bytes");
  if (o.requesterText !== undefined && [...o.requesterText].length > 1000) bad("requester_text is at most 1,000 characters");
  const aggregate = o.closesAt !== undefined;
  if (aggregate === (o.endsAt !== undefined || o.keyPeriod !== undefined)) bad("give closes_at (aggregate) or ends_at with key_period (per-input), not both");
  const opens = parseTimestamp(o.opensAt);
  if (aggregate) { if (parseTimestamp(o.closesAt!) <= opens) bad("closes_at must be after opens_at"); }
  else {
    if (o.endsAt === undefined || o.keyPeriod === undefined) bad("a per-input job needs both ends_at and key_period");
    parseDuration(o.keyPeriod!);
    if (parseTimestamp(o.endsAt!) > opens + 366 * 86_400_000) bad("ends_at is more than a year after opens_at");
  }
  parseTimestamp(o.createdAt);
  const unsigned: Record<string, unknown> = {
    ...(aggregate ? { closes_at: o.closesAt } : { ends_at: o.endsAt, key_period: o.keyPeriod }),
    created_at: o.createdAt, kem: "x-wing-draft-06", min_live: minLive, nonce: b64uEncode(o.nonce), opens_at: o.opensAt,
    parameters: o.parameters ?? {}, policy_id: o.policyId, policy_state_cid: o.policyStateCid,
    replica_set: o.replicaSet.map((r) => ({ instances: r.instances, notary_card: r.notary_card })),
    requester_card: cardPointer(o.requester.publicKey), requester_pubkey: b64uEncode(o.requester.publicKey),
    ...(o.requesterText !== undefined ? { requester_text: o.requesterText } : {}), type: "notary.job.v1",
  };
  const signature = await o.requester.sign(canonicalNotary(unsigned));
  const job = { ...unsigned, requester_signature: { public_key: b64uEncode(o.requester.publicKey), signature: b64uEncode(signature) } } as unknown as NotaryJob;
  const jobBytes = canonicalNotary(job);
  return { job, jobHash: H(job), jobBytes, jobCid: cidOfBytes(jobBytes) };
}

export interface SendJobOptions {
  built: BuiltJob;
  programCid: string;
  /** Host base URLs, one per replica operator. */
  hosts: string[];
  /** POSTs JSON to `${host}/jobs`; resolves with the parsed response. */
  post(url: string, body: unknown): Promise<{ job_hash: string; status: string }>;
}

export type SendJobResult = { host: string; ok: true; status: string } | { host: string; ok: false; reason: string };

/** Sends the job to each replica host (host_spec §5 `POST /jobs`). A host's `job_hash` must equal ours. */
export async function sendNotaryJob(o: SendJobOptions): Promise<SendJobResult[]> {
  return Promise.all(o.hosts.map(async (host): Promise<SendJobResult> => {
    try {
      const r = await o.post(`${host.replace(/\/$/, "")}/jobs`, { job: o.built.job, program_cid: o.programCid });
      if (r.job_hash !== o.built.jobHash) return { host, ok: false, reason: "host returned a different job_hash" };
      return { host, ok: true, status: r.status };
    } catch (e) { return { host, ok: false, reason: String((e as Error).message) }; }
  }));
}


