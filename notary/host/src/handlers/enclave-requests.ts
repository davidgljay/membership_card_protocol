/**
 * What the host does when an enclave asks (notary_runtime.md §9, enclave → host). The host answers `fetch`; pins and
 * serves what is `publish`ed and `announce`d; submits `chain_submit` payloads unchanged; anchors `eas_anchor`
 * records and returns the receipt; relays `deliver` and `peer_send`; starts replicas on `need_replica`; and
 * forwards `alert` for operator monitoring only.
 */
import { assertNotaryObject, b64uDecode, b64uEncode, canonicalNotary, cidOfBytes, parseCanonicalNotary } from "@membership-card-protocol/wallet-sdk/notary-types";
import type { HostContext } from "../context.js";
import type { EnclaveSession } from "../enclave/transport.js";
import type { Msg } from "../enclave/protocol.js";
import { pinExact } from "../ipfs/index.js";
import { sanitizeAlert } from "../monitoring/index.js";

const str = (m: Msg, k: string) => (typeof m[k] === "string" ? (m[k] as string) : "");

export function attachEnclave(ctx: HostContext, session: EnclaveSession): void {
  session.onEnclaveRequest((m) => { void handleEnclaveRequest(ctx, session, m).catch(() => ctx.monitor.alert("error", "enclave_lost")); });
}

export async function handleEnclaveRequest(ctx: HostContext, session: EnclaveSession, m: Msg): Promise<void> {
  switch (m.kind) {
    case "fetch": return fetchRequest(ctx, session, m);
    case "publish": return publish(ctx, m);
    case "announce": return announce(ctx, m);
    case "chain_submit": {
      const r = await ctx.submitter.submit({ op: str(m, "op"), payload: m["payload"], signature: str(m, "signature"), calldata: str(m, "calldata") });
      return session.notify("chain_result", m.req_id, "txHash" in r ? { tx_receipt: r.txHash } : { failed: r.failed });
    }
    case "eas_anchor": {
      const a = { scopeId: str(m, "scope_id"), seq: Number(m["seq"]), recordCid: str(m, "record_cid") };
      try {
        const { txHash } = await ctx.eas.anchor(a);
        await ctx.logs.setAnchor(a.scopeId, a.seq, txHash);
        return session.notify("anchor_receipt", m.req_id, { scope_id: a.scopeId, seq: a.seq, tx_receipt: txHash });
      } catch { await ctx.monitor.alert("warn", "anchor_backlog", { seq: a.seq }); return; } // no receipt: the enclave stops until one exists
    }
    case "deliver": try { return await ctx.delivery.deliver(m["routing_envelope"]); } catch { return ctx.monitor.alert("warn", "storage_failure"); }
    case "peer_send": return peerSend(ctx, session, m);
    case "need_replica": try { return await ctx.replicas.start(str(m, "job_hash") || null, str(m, "notary_card") || null); } catch { return ctx.monitor.alert("error", "need_replica_failed"); }
    case "alert": { const a = sanitizeAlert(str(m, "level"), str(m, "code")); return ctx.monitor.alert(a.level as "info", a.code); }
    default: return;
  }
}

async function fetchRequest(ctx: HostContext, session: EnclaveSession, m: Msg): Promise<void> {
  const what = str(m, "what");
  const [kind, ...rest] = what.split(":");
  const arg = rest.join(":");
  let bytes: Uint8Array | null = null;
  if (kind === "ipfs") bytes = ctx.served.get(arg) ?? (await ctx.ipfs.fetch(arg));
  else if (kind === "policy_snapshot") { const s = await ctx.snapshots.get(arg); bytes = s ? canonicalNotary(s) : null; }
  else if (kind === "card_head") bytes = await ctx.chain.cardHead(arg);
  else if (kind === "press_auth" || kind === "subcard" || kind === "events") {
    const v = kind === "press_auth" ? await ctx.chain.pressAuth(...(arg.split(",") as [string, string])) : kind === "subcard" ? await ctx.chain.subcard(arg) : await ctx.chain.events(arg);
    bytes = v ? canonicalNotary(v) : null;
  }
  return session.notify("fetch_result", m.req_id, bytes ? { bytes: b64uEncode(bytes) } : { not_found: true });
}

/** Pins exact bytes, serves them by CID, and indexes job-log and identity-log records. */
async function publish(ctx: HostContext, m: Msg): Promise<void> {
  const bytes = b64uDecode(str(m, "object"));
  const cid = m["pin"] === false ? cidOfBytes(bytes) : await pinExact(ctx.ipfs, bytes);
  ctx.served.set(cid, bytes);
  try {
    const obj = parseCanonicalNotary(bytes) as Record<string, unknown>;
    if (obj["type"] === "notary.job_log.v1" || obj["type"] === "notary.identity_log.v1") {
      assertNotaryObject(obj, obj["type"] as string);
      const scope = String(obj["job_hash"]);
      await ctx.logs.append(scope, { seq: Number(obj["seq"]), record_cid: cid });
      const j = await ctx.jobs.get(scope);
      if (j && obj["type"] === "notary.job_log.v1") {
        const next = { ...j, logHead: cid };
        if (obj["kind"] === "notarized" || obj["kind"] === "aborted") { await ctx.jobs.retire(next, obj["kind"] === "notarized" ? "finalized" : "aborted"); await ctx.inputs.deleteAll(scope); }
        else await ctx.jobs.put(next);
      }
    }
  } catch { /* not a log record: just pinned and served */ }
}

async function announce(ctx: HostContext, m: Msg): Promise<void> {
  const ann = m["announcement"] as { job?: unknown; epoch?: number } | undefined;
  try { assertNotaryObject(ann, "notary.announcement.v1"); } catch { return; }
  const { H } = await import("@membership-card-protocol/wallet-sdk/notary-types");
  const j = await ctx.jobs.get(H((ann as { job: unknown }).job));
  if (!j) return;
  const bytes = canonicalNotary(ann);
  const cid = await pinExact(ctx.ipfs, bytes);
  ctx.served.set(cid, bytes);
  await ctx.jobs.put({ ...j, announcement: ann, epoch: Number(ann!.epoch ?? j.epoch), state: j.state === "keyed" ? "open" : j.state });
}

async function peerSend(ctx: HostContext, session: EnclaveSession, m: Msg): Promise<void> {
  const to = str(m, "to_instance"), bytes = str(m, "bytes");
  const from = [...ctx.instances].find(([, s]) => s === session)?.[0] ?? "";
  const local = ctx.instances.get(to);
  if (local && !local.closed) return local.notify("peer_message", `peer-${ctx.now()}`, { from_instance: from, bytes });
  for (const url of ctx.config.PEER_HOSTS) { try { await ctx.peers.send(url, { to_instance: to, from_instance: from, bytes }); return; } catch { /* try the next host */ } }
  await ctx.monitor.alert("warn", "enclave_lost");
}
