/**
 * Job intake, announcements and status (notary_host.md §5; notary_lifecycle.md Phase 2).
 *
 * `POST /jobs` (direct, from the requester): the host validates the job against the policy, fetches the program,
 * sends `create_job` to a local enclave, and records the result. The enclave repeats every check; the host's checks
 * only keep obviously invalid jobs from reaching an enclave. `GET /jobs/{hash}/announcement` and the status route
 * are read-only.
 */
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { sha256 } from "@noble/hashes/sha256";
import { assertNotaryObject, b64uDecode, b64uEncode, canonicalNotary, cardPointer, digestFromCid, H, withoutFields } from "@membership-card-protocol/wallet-sdk/notary-types";
import type { NotaryJob } from "@membership-card-protocol/wallet-sdk/notary-types";
import { HostError } from "../context.js";
import type { HostContext } from "../context.js";
import type { EnclaveSession } from "../enclave/transport.js";
import { EnclaveError } from "../enclave/transport.js";
import { pinExact } from "../ipfs/index.js";
import type { StoredJob } from "../storage/index.js";

export function liveSession(ctx: HostContext, preferred?: string[]): EnclaveSession {
  for (const id of preferred ?? []) { const s = ctx.instances.get(id); if (s && !s.closed) return s; }
  if (preferred && preferred.length > 0) throw new HostError("NH_ENCLAVE_UNAVAILABLE", "no local enclave holds this job; retry", 503);
  for (const s of ctx.sessions.values()) if (!s.closed) return s;
  throw new HostError("NH_ENCLAVE_UNAVAILABLE", "no local enclave is available; retry", 503);
}

export async function handleCreateJob(ctx: HostContext, body: { job?: unknown; program_cid?: string }): Promise<{ job_hash: string; status: string }> {
  const bad = (code: string, m: string, status = 400): never => { throw new HostError(code, m, status); };
  if (!body || typeof body.program_cid !== "string" || body.job === undefined) bad("JOB_MALFORMED", "body must be { job, program_cid }");
  try { assertNotaryObject(body.job, "notary.job.v1"); } catch (e) { return bad("JOB_MALFORMED", (e as Error).message); }
  const job = body.job as unknown as NotaryJob;
  // requester signature and job_hash
  try {
    const pk = b64uDecode(job.requester_pubkey, 1312);
    if (cardPointer(pk) !== job.requester_card || job.requester_signature.public_key !== job.requester_pubkey ||
        !ml_dsa44.verify(b64uDecode(job.requester_signature.signature, 2420), canonicalNotary(withoutFields(job as never, "requester_signature")), pk))
      return bad("JOB_SIGNATURE_INVALID", "requester signature does not verify");
  } catch { return bad("JOB_SIGNATURE_INVALID", "requester key or signature malformed"); }
  const jobHash = H(job);
  const n = job.replica_set.reduce((a, r) => a + r.instances, 0);
  if (job.replica_set.length === 0 || !(Math.floor(n / 2) + 1 <= job.min_live && job.min_live <= n)) return bad("JOB_MALFORMED", "min_live must satisfy q <= min_live <= N");
  // this operator must serve at least one replica card
  const local = job.replica_set.filter((r) => ctx.config.NOTARY_CARD_ADDRESSES.includes(r.notary_card));
  if (local.length === 0) return bad("JOB_NOTARY_NOT_APPROVED", "none of this job's replica_set cards is served by this operator");
  // policy
  const policy = await ctx.policies.notary(job.policy_id, job.policy_state_cid);
  if (!policy) return bad("JOB_POLICY_UNTRUSTED", "policy not found at the job's policy_state_cid");
  if (!local.every((r) => policy.approvedNotaries.includes(r.notary_card))) return bad("JOB_NOTARY_NOT_APPROVED", "a local replica card is not in approved_notaries");
  if (body.program_cid !== policy.notary.program_cid) return bad("JOB_MALFORMED", "program_cid is not the policy's program_cid");
  // program bytes, checked against their CID digest before the enclave sees them (it re-checks: A1)
  const program = await ctx.ipfs.fetch(body.program_cid);
  if (!program) return bad("JOB_MALFORMED", "program not available from IPFS");
  let digestOk: boolean;
  try { digestOk = b64uEncode(digestFromCid(body.program_cid)) === b64uEncode(sha256(program)); }
  catch { return bad("JOB_MALFORMED", "program_cid is not a raw sha2-256 CIDv1"); }
  if (!digestOk) return bad("ADM_HASH_MISMATCH", "program bytes do not match program_cid");
  const existing = await ctx.jobs.get(jobHash);
  if (existing && existing.state !== "aborted") return { job_hash: jobHash, status: existing.state };

  const session = liveSession(ctx);
  let reply;
  try {
    reply = await session.call("create_job", {
      job, program: b64uEncode(program),
      transport: { key_config_url: `${ctx.config.NOTARY_PUBLIC_BASE_URL.replace(/\/$/, "")}/ohttp/key-config`, relay_target_id: ctx.config.NOTARY_RELAY_TARGET_ID },
    });
  } catch (e) { if (e instanceof EnclaveError) throw new HostError(e.code, e.message, e.code === "NH_ENCLAVE_UNAVAILABLE" ? 503 : 400); throw e; }
  if (reply.kind === "job_rejected") throw new HostError(String(reply["code"]), "the enclave rejected the job");
  const attCid = await pinExact(ctx.ipfs, b64uDecode(String(reply["attestation"])));
  const stored: StoredJob = { job, jobHash, programCid: body.program_cid, announcement: null, epoch: Number(reply["epoch"]), replicas: instanceIdOf(ctx, session), state: "keyed", logHead: null };
  await ctx.jobs.put(stored);
  void attCid;
  return { job_hash: jobHash, status: "keyed" };
}

function instanceIdOf(ctx: HostContext, session: EnclaveSession): string[] {
  for (const [id, s] of ctx.instances) if (s === session) return [id];
  return [];
}

export async function handleGetAnnouncement(ctx: HostContext, jobHash: string): Promise<unknown> {
  const j = await ctx.jobs.get(jobHash);
  if (!j || j.announcement === null) throw new HostError("NH_JOB_UNKNOWN", "no such job on this host", 404);
  return j.announcement;
}

export async function handleJobStatus(ctx: HostContext, jobHash: string): Promise<{ state: string; epoch: number; live_replicas: number; job_log_head: string | null }> {
  const j = await ctx.jobs.get(jobHash);
  if (!j) throw new HostError("NH_JOB_UNKNOWN", "no such job on this host", 404);
  const live = j.replicas.filter((id) => { const s = ctx.instances.get(id); return s && !s.closed; }).length;
  return { state: j.state, epoch: j.epoch, live_replicas: live, job_log_head: j.logHead };
}
