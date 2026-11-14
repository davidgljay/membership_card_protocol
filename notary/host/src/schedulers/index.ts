/**
 * The host's schedulers (notary_host.md §8; replication §5):
 * - **headers**: streams new block headers to every local enclave (`chain_headers`);
 * - **snapshots**: for each live job, a whole-policy snapshot of every policy it depends on (`issued_under_template`
 *   policies in `contributor_predicate`, and a derived-card job's `source_policy`), sent as `policy_snapshot` once and
 *   then as `policy_updates`. Never filtered;
 * - **close**: once a job's `closes_at` has passed on the chain, sends its stored ciphertexts in `close_chunk`s. An
 *   early attempt (`CLOSE_NOT_DUE`, the enclave's attested clock not there yet) is retried on the next tick. The
 *   notarization and its log record are published by the enclave (`publish`), which also retires the job here.
 *
 * Each tick is one function, so tests drive them directly; `startSchedulers` runs them on timers.
 */
import { canonicalNotary, cidOfBytes } from "@membership-card-protocol/wallet-sdk/notary-types";
import type { HostContext } from "../context.js";
import type { ChainFeed } from "../services.js";
import { buildSnapshot, buildUpdates } from "../chain/snapshots.js";
import { EnclaveError } from "../enclave/transport.js";

const CLOSE_CHUNK = 256;

export interface SchedulerState {
  /** Newest header number sent to the enclaves; newest chain timestamp (ms). */
  newestHeader: number;
  chainTimeMs: number;
  /** policy → block of the last snapshot or update sent. */
  sentPolicies: Map<string, number>;
  /** Jobs with a close in flight. */
  closing: Set<string>;
}

export const newSchedulerState = (): SchedulerState => ({ newestHeader: 0, chainTimeMs: 0, sentPolicies: new Map(), closing: new Set() });

export async function headersTick(ctx: HostContext, feed: ChainFeed, st: SchedulerState): Promise<void> {
  const hs = await feed.headersAfter(st.newestHeader);
  if (hs.length === 0) return;
  // A header that does not link to the enclave's chain is dropped, so a batch the enclave never received must be sent
  // again: the cursor moves only when at least one live enclave exists and every live enclave acknowledged the batch
  // (5.7: it used to move after a failed call, which left a gap that froze that enclave's chain for good). An enclave
  // that already has the headers ignores the repeat.
  let delivered = 0;
  let failed = false;
  for (const s of ctx.sessions.values()) {
    if (s.closed) continue;
    try { await s.call("chain_headers", { headers: hs.map((h) => ({ number: h.number, header_rlp: h.header_rlp })) }); delivered++; } catch { failed = true; }
  }
  const last = hs[hs.length - 1]!;
  st.chainTimeMs = last.timestamp * 1000;
  if (delivered > 0 && !failed) st.newestHeader = last.number;
}

/** Policies a job depends on (notary_host.md §8). */
export function relevantPolicies(job: unknown, notary: unknown): string[] {
  const out = new Set<string>();
  const walk = (p: unknown) => {
    if (!p || typeof p !== "object") return;
    if (Array.isArray(p)) { p.forEach(walk); return; }
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (k === "issued_under_template") {
        if (typeof v === "string") out.add(v);
        else if (v && typeof v === "object" && typeof (v as { param?: unknown }).param === "string") {
          const val = ((job as { parameters?: Record<string, unknown> }).parameters ?? {})[(v as { param: string }).param];
          if (typeof val === "string") out.add(val);
        }
      } else walk(v);
    }
  };
  const n = notary as { contributor_predicate?: unknown; derived_card?: { source_policy?: string } } | null;
  walk(n?.contributor_predicate);
  const sp = n?.derived_card?.source_policy ?? ((job as { parameters?: Record<string, unknown> }).parameters ?? {})["source_policy"];
  if (n?.derived_card && typeof sp === "string") out.add(sp);
  return [...out].sort();
}

async function liveJobs(ctx: HostContext) {
  const out = [];
  for (const h of await ctx.jobs.list()) { const j = await ctx.jobs.get(h); if (j && (j.state === "keyed" || j.state === "open" || j.state === "closing")) out.push(j); }
  return out;
}

export async function snapshotsTick(ctx: HostContext, feed: ChainFeed, st: SchedulerState): Promise<void> {
  const policies = new Set<string>();
  for (const j of await liveJobs(ctx)) {
    const job = j.job as { policy_id: string; policy_state_cid: string };
    const p = await ctx.policies.notary(job.policy_id, job.policy_state_cid);
    for (const x of relevantPolicies(job, p?.notary)) policies.add(x);
  }
  for (const policy of policies) {
    const r = await feed.registry(policy);
    const heads = new Map<string, Uint8Array>();
    for (const e of r.events) { if (!heads.has(e.headCid)) { const b = await ctx.ipfs.fetch(e.headCid); if (b) heads.set(e.headCid, b); } }
    const since = st.sentPolicies.get(policy);
    for (const s of ctx.sessions.values()) {
      if (s.closed) continue;
      if (since === undefined) {
        const snap = buildSnapshot(policy, r.events, r.subcards, heads, r.block);
        await ctx.snapshots.put(policy, snap);
        try { await s.call("policy_snapshot", { ...snap }); } catch { continue; }
      } else {
        const updates = buildUpdates(policy, r.events, since, heads);
        if (updates.length) await s.notify("policy_updates", `upd-${policy}-${r.block}`, { policy_address: policy, updates });
      }
    }
    st.sentPolicies.set(policy, r.block);
  }
}

export async function closeTick(ctx: HostContext, st: SchedulerState): Promise<void> {
  for (const j of await liveJobs(ctx)) {
    if (j.state !== "open" || st.closing.has(j.jobHash)) continue;
    const closesMs = Date.parse(String((j.job as { closes_at?: string }).closes_at));
    if (!(st.chainTimeMs >= closesMs)) continue;
    const session = j.replicas.map((id) => ctx.instances.get(id)).find((s) => s && !s.closed);
    if (!session) continue;
    st.closing.add(j.jobHash);
    try {
      const keys = await ctx.inputs.list(j.jobHash);
      const sealed = [];
      for (const k of keys) { const [, , epoch, inputHash] = k.split(":"); const v = await ctx.inputs.get(j.jobHash, Number(epoch), inputHash!); if (v) sealed.push(v.sealedInput); }
      const chunks = [];
      for (let i = 0; i < sealed.length; i += CLOSE_CHUNK) chunks.push(sealed.slice(i, i + CLOSE_CHUNK));
      if (chunks.length === 0) chunks.push([]);
      for (let i = 0; i < chunks.length - 1; i++) await session.notify("close_chunk", `close-${j.jobHash}-${i}`, { job_hash: j.jobHash, seq: i, sealed_inputs: chunks[i], last: false });
      const reply = await session.call("close_chunk", { job_hash: j.jobHash, seq: chunks.length - 1, sealed_inputs: chunks[chunks.length - 1], last: true });
      if (reply.kind === "job_closed" && reply["notarization"] && typeof reply["notarization"] === "object") {
        // the enclave also publishes it; pinning the same canonical bytes again is idempotent and keeps it served by CID
        const bytes = canonicalNotary(reply["notarization"]);
        ctx.served.set(cidOfBytes(bytes), bytes);
        await ctx.ipfs.pin(bytes);
      }
    } catch (e) {
      if (!(e instanceof EnclaveError && e.code === "CLOSE_NOT_DUE")) await ctx.monitor.alert("warn", "close_failed");
    } finally { st.closing.delete(j.jobHash); }
  }
}

/** Runs the three schedulers on timers. Returns a stop function. */
export function startSchedulers(ctx: HostContext, feed: ChainFeed, o: { headerMs?: number; snapshotSeconds: number; closeMs?: number }): () => void {
  const st = newSchedulerState();
  const guard = (f: () => Promise<void>) => { let busy = false; return async () => { if (busy) return; busy = true; try { await f(); } catch { /* next tick */ } finally { busy = false; } }; };
  const timers = [
    setInterval(guard(() => headersTick(ctx, feed, st)), o.headerMs ?? 1000),
    setInterval(guard(() => snapshotsTick(ctx, feed, st)), o.snapshotSeconds * 1000),
    setInterval(guard(() => closeTick(ctx, st)), o.closeMs ?? 2000),
  ];
  return () => timers.forEach(clearInterval);
}
