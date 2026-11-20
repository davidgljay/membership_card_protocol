/**
 * The host's part in replication (notary_host.md §11; notary_replication_and_recovery.md; step 6.3).
 *
 * The host trusts nothing here and decides nothing: it relays, stores and indexes.
 * - **`POST /peer`** carries, besides envelopes for a local instance (`handlePeer`): job-log and identity-log records
 *   a peer host's enclave published (`log_record`), their anchors (`anchor`), announcements, this host's directory, and
 *   stored ciphertexts asked for by `need_inputs`.
 * - **Relaying**: every record and anchor a local enclave produces goes to every peer host and to the other local
 *   enclaves; peer hosts give them to their enclaves as `log_record` and `anchor_receipt { record }`. Enclaves check
 *   every signature themselves.
 * - **Ciphertexts (Q8, R4)**: `need_inputs` fetches missing `SealedInput`s from peer hosts and `store_input` stores an
 *   input the enclave acknowledged for a peer, each only after checking `H(sealed) == input_hash` here.
 * - **Which local enclave holds a job** is learned from the records: `opened` / `epoch_started` by a local instance,
 *   a job-scope `handoff` to one, minus `replica_lost`.
 * - **Directory (Q5) and ticks (Q6)**: `directoryTick` sends each enclave `peer_directory` (local instances plus
 *   every peer host's), and `tickTick` sends `tick {}`.
 */
import { assertNotaryObject, b64uDecode, b64uEncode, canonicalNotary, cidOfBytes, H, parseCanonicalNotary } from "@membership-card-protocol/wallet-sdk/notary-types";
import { HostError, requireOperator } from "../context.js";
import type { HostContext } from "../context.js";
import { EnclaveError } from "../enclave/transport.js";
import type { EnclaveSession } from "../enclave/transport.js";
import type { Msg } from "../enclave/protocol.js";
import { pinExact } from "../ipfs/index.js";
import { liveSession } from "./jobs.js";

type Rec = { type: string; job_hash: string; seq: number; kind: string; instance: string; body: Record<string, unknown> };

const localSessions = (ctx: HostContext, except?: EnclaveSession) => [...ctx.sessions.values()].filter((s) => !s.closed && s !== except);

/** Parses a published object; returns it if it is a job-log or identity-log record. */
export function asLogRecord(bytes: Uint8Array): Rec | null {
  try {
    const obj = parseCanonicalNotary(bytes) as Record<string, unknown>;
    if (obj["type"] !== "notary.job_log.v1" && obj["type"] !== "notary.identity_log.v1") return null;
    assertNotaryObject(obj, obj["type"] as string);
    return obj as unknown as Rec;
  } catch { return null; }
}

/** Indexes a record (log index, job head, retirement) and tracks which local instance holds the job. */
export async function indexRecord(ctx: HostContext, rec: Rec, cid: string): Promise<void> {
  const scope = rec.job_hash;
  const known = (await ctx.logs.list(scope)).some((e) => e.seq === rec.seq && e.record_cid === cid);
  if (!known) await ctx.logs.append(scope, { seq: rec.seq, record_cid: cid });
  if (rec.type !== "notary.job_log.v1") return;
  const j = await ctx.jobs.get(scope);
  if (!j) return;
  let replicas = [...j.replicas];
  if ((rec.kind === "opened" || rec.kind === "epoch_started") && ctx.instances.has(rec.instance)) replicas = [rec.instance];
  else if (rec.kind === "epoch_started") replicas = [];
  if (rec.kind === "handoff" && rec.body["scope"] === "job" && typeof rec.body["to_instance"] === "string" && ctx.instances.has(rec.body["to_instance"])) replicas = [...new Set([...replicas, rec.body["to_instance"]])];
  if (rec.kind === "replica_lost") replicas = replicas.filter((i) => i !== rec.body["instance"]);
  const newer = (j.logSeq ?? -1) < rec.seq;
  const next = { ...j, replicas, ...(newer ? { logHead: cid, logSeq: rec.seq } : {}) };
  if (rec.kind === "notarized" || rec.kind === "aborted") { await ctx.jobs.retire(next, rec.kind === "notarized" ? "finalized" : "aborted"); await ctx.inputs.deleteAll(scope); }
  else await ctx.jobs.put(next);
}

async function toPeers(ctx: HostContext, body: Record<string, unknown>): Promise<void> {
  await Promise.all(ctx.config.PEER_HOSTS.map(async (url) => { try { await ctx.peers.request(url, body); } catch { /* that host catches up from later records */ } }));
}

/** A record a local enclave published: indexed here, relayed to the other local enclaves and to every peer host. */
export async function relayRecord(ctx: HostContext, from: EnclaveSession | null, bytes: Uint8Array, cid: string): Promise<void> {
  const rec = asLogRecord(bytes);
  if (!rec) return;
  await indexRecord(ctx, rec, cid);
  const record = b64uEncode(bytes);
  for (const s of localSessions(ctx, from ?? undefined)) await s.notify("log_record", `rec-${cid}`, { scope_id: rec.job_hash, seq: rec.seq, record });
  if (from) await toPeers(ctx, { kind: "log_record", scope_id: rec.job_hash, seq: rec.seq, record });
}

/** An anchor of a record a local enclave wrote: given to the other local enclaves (with the record) and to peer hosts. */
export async function relayAnchor(ctx: HostContext, from: EnclaveSession, scopeId: string, seq: number, recordCid: string, txHash: string): Promise<void> {
  const bytes = ctx.served.get(recordCid) ?? (await ctx.ipfs.fetch(recordCid));
  if (!bytes) return;
  const record = b64uEncode(bytes);
  for (const s of localSessions(ctx, from)) await s.notify("anchor_receipt", `anc-${recordCid}`, { scope_id: scopeId, seq, tx_receipt: txHash, record });
  await toPeers(ctx, { kind: "anchor", scope_id: scopeId, seq, tx_receipt: txHash, record });
}

/** An announcement a local enclave signed: peer hosts serve it too (wallets may come through any operator's host). */
export async function relayAnnouncement(ctx: HostContext, announcement: unknown): Promise<void> {
  await toPeers(ctx, { kind: "announce", announcement });
}

/** Stores an announcement for a job this host knows, newest epoch first. */
export async function storeAnnouncement(ctx: HostContext, ann: unknown): Promise<void> {
  try { assertNotaryObject(ann, "notary.announcement.v1"); } catch { return; }
  const a = ann as { job: unknown; epoch?: number };
  const j = await ctx.jobs.get(H(a.job));
  if (!j || j.state === "finalized" || j.state === "aborted" || j.state === "ended") return;
  const epoch = Number(a.epoch ?? 0);
  const current = j.announcement as { epoch?: number } | null;
  if (current && Number(current.epoch ?? 0) > epoch) return;
  const bytes = canonicalNotary(ann);
  const cid = await pinExact(ctx.ipfs, bytes);
  ctx.served.set(cid, bytes);
  await ctx.jobs.put({ ...j, announcement: ann, epoch, state: j.state === "keyed" ? "open" : j.state });
}

const sealedHash = (s: unknown): string | null => { try { assertNotaryObject(s, "notary.sealed_input.v1"); return H(s); } catch { return null; } };

/** R4: an input the local enclave acknowledged for a peer replica; stored only if it is what the enclave named. */
export async function storeInput(ctx: HostContext, m: Msg): Promise<void> {
  const sealed = m["sealed_input"];
  const ih = String(m["input_hash"] ?? "");
  if (sealedHash(sealed) !== ih) return;
  const s = sealed as { job_hash: string; epoch: number };
  if (s.job_hash !== m["job_hash"]) return;
  if (await ctx.inputs.get(s.job_hash, s.epoch, ih)) return;
  await ctx.inputs.put(s.job_hash, s.epoch, ih, { sealedInput: sealed, receivedAt: new Date(ctx.now()).toISOString() });
}

/** Q8: fetches each missing ciphertext from peer hosts and keeps only one that hashes to the name asked for. */
export async function needInputs(ctx: HostContext, m: Msg): Promise<number> {
  const jobHash = String(m["job_hash"] ?? ""), epoch = Number(m["epoch"]);
  const hashes = (Array.isArray(m["hashes"]) ? m["hashes"] : []).filter((h): h is string => typeof h === "string");
  const missing = [];
  for (const h of hashes) if (!(await ctx.inputs.get(jobHash, epoch, h))) missing.push(h);
  let got = 0;
  for (const url of ctx.config.PEER_HOSTS) {
    if (missing.length === 0) break;
    let answer: unknown;
    try { answer = await ctx.peers.request(url, { kind: "inputs", job_hash: jobHash, epoch, hashes: missing }); } catch { continue; }
    for (const s of (answer as { inputs?: unknown[] })?.inputs ?? []) {
      const h = sealedHash(s);
      const i = h === null ? -1 : missing.indexOf(h);
      if (i < 0 || (s as { job_hash?: string; epoch?: number }).job_hash !== jobHash || (s as { epoch?: number }).epoch !== epoch) continue;
      await ctx.inputs.put(jobHash, epoch, h!, { sealedInput: s, receivedAt: new Date(ctx.now()).toISOString() });
      missing.splice(i, 1);
      got++;
    }
  }
  if (got > 0) ctx.restream.add(jobHash);
  return got;
}

/**
 * `POST /peer` (direct, from peer hosts). Without `kind` (or `kind: "message"`) it relays an envelope to a local
 * instance; the other kinds are listed in the module comment.
 */
export async function handlePeerPost(ctx: HostContext, body: Record<string, unknown>): Promise<unknown> {
  const kind = typeof body?.["kind"] === "string" ? body["kind"] : "message";
  switch (kind) {
    case "message": {
      const to = body["to_instance"], from = body["from_instance"], bytes = body["bytes"];
      if (typeof to !== "string" || typeof from !== "string" || typeof bytes !== "string") throw new HostError("MISSING_FIELD", "to_instance, from_instance and bytes are required");
      const s = ctx.instances.get(to);
      if (!s || s.closed) throw new HostError("NH_ENCLAVE_UNAVAILABLE", "the named instance is not running here", 503);
      await s.notify("peer_message", `peer-${ctx.now()}`, { from_instance: from, bytes });
      return { delivered: true };
    }
    case "log_record":
    case "anchor": {
      if (typeof body["record"] !== "string") throw new HostError("MISSING_FIELD", "record is required");
      const bytes = b64uDecode(body["record"]);
      const rec = asLogRecord(bytes);
      if (!rec || rec.job_hash !== body["scope_id"] || rec.seq !== Number(body["seq"])) throw new HostError("NH_MALFORMED", "not a log record for that scope and seq");
      const cid = cidOfBytes(bytes);
      ctx.served.set(cid, bytes);
      await indexRecord(ctx, rec, cid);
      if (kind === "anchor" && typeof body["tx_receipt"] === "string") await ctx.logs.setAnchor(rec.job_hash, rec.seq, body["tx_receipt"]);
      for (const s of localSessions(ctx)) {
        if (kind === "anchor") await s.notify("anchor_receipt", `anc-${cid}`, { scope_id: rec.job_hash, seq: rec.seq, tx_receipt: String(body["tx_receipt"] ?? ""), record: body["record"] });
        else await s.notify("log_record", `rec-${cid}`, { scope_id: rec.job_hash, seq: rec.seq, record: body["record"] });
      }
      return { ok: true };
    }
    case "announce": await storeAnnouncement(ctx, body["announcement"]); return { ok: true };
    case "directory": return { peers: localDirectory(ctx) };
    case "inputs": {
      const jobHash = String(body["job_hash"] ?? ""), epoch = Number(body["epoch"]);
      const out = [];
      for (const h of Array.isArray(body["hashes"]) ? body["hashes"].slice(0, 10_000) : []) {
        const v = typeof h === "string" ? await ctx.inputs.get(jobHash, epoch, h) : null;
        if (v) out.push(v.sealedInput);
      }
      return { inputs: out };
    }
    // 6.5: an object this host stores unpinned (a notary card's state blob header and encrypted body, replication §8),
    // for another holder of the card whose own host doesn't have it. The asker checks the bytes against the CID.
    case "object": {
      const cid = String(body["cid"] ?? "");
      const bytes = ctx.served.get(cid);
      return bytes ? { bytes: b64uEncode(bytes) } : { not_found: true };
    }
    default: throw new HostError("NH_MALFORMED", `unknown peer kind ${kind}`);
  }
}

/** 6.5: an object by CID from the peer hosts (only bytes that hash to the CID are kept). */
export async function objectFromPeers(ctx: HostContext, cid: string): Promise<Uint8Array | null> {
  for (const url of ctx.config.PEER_HOSTS) {
    let answer: unknown;
    try { answer = await ctx.peers.request(url, { kind: "object", cid }); } catch { continue; }
    const b = (answer as { bytes?: unknown })?.bytes;
    if (typeof b !== "string") continue;
    const bytes = b64uDecode(b);
    if (cidOfBytes(bytes) !== cid) continue;
    ctx.served.set(cid, bytes);
    return bytes;
  }
  return null;
}

/** This host's own entries for peer directories. */
export function localDirectory(ctx: HostContext): { instance: string; notary_card: string; inst_pubkey: string; attestation: string; host_url: string }[] {
  const out = [];
  for (const [instance, s] of ctx.instances) {
    const pk = ctx.instanceKeys.get(instance);
    if (s.closed || !pk) continue;
    out.push({ instance, notary_card: ctx.instanceCards.get(instance) ?? ctx.cards.all()[0] ?? "", inst_pubkey: pk, attestation: "", host_url: ctx.config.NOTARY_PUBLIC_BASE_URL });
  }
  return out;
}

/** Q5: every enclave gets the local instances and every peer host's; peer instances are routed to their host. */
export async function directoryTick(ctx: HostContext): Promise<void> {
  const peers = [...localDirectory(ctx)];
  for (const url of ctx.config.PEER_HOSTS) {
    let answer: unknown;
    try { answer = await ctx.peers.request(url, { kind: "directory" }); } catch { continue; }
    for (const p of (answer as { peers?: unknown[] })?.peers ?? []) {
      const e = p as Record<string, unknown>;
      if (typeof e["instance"] !== "string" || typeof e["inst_pubkey"] !== "string" || typeof e["notary_card"] !== "string") continue;
      ctx.peerRoutes.set(e["instance"], url);
      peers.push({ instance: e["instance"], notary_card: e["notary_card"], inst_pubkey: e["inst_pubkey"], attestation: "", host_url: url });
    }
  }
  for (const s of localSessions(ctx)) { try { await s.notify("peer_directory", `dir-${ctx.now()}`, { peers }); } catch { /* next tick */ } }
}

/** Q6: `tick {}` to every enclave; it carries no time. */
export async function tickTick(ctx: HostContext): Promise<void> {
  for (const s of localSessions(ctx)) { try { await s.notify("tick", `tick-${ctx.now()}`); } catch { /* next tick */ } }
}

/** A `job_closed` that arrives after the `close_pending` answer (the leader, once q cosignatures are in). */
export async function lateJobClosed(ctx: HostContext, m: Msg): Promise<void> {
  const n = m["notarization"];
  if (!n || typeof n !== "object") return;
  const bytes = canonicalNotary(n);
  ctx.served.set(cidOfBytes(bytes), bytes);
  await ctx.ipfs.pin(bytes);
  for (const envelope of Array.isArray(m["outputs"]) ? m["outputs"] : []) {
    try { await ctx.delivery.deliver(envelope); } catch { await ctx.monitor.alert("warn", "delivery_failed"); }
  }
}

async function viaEnclave(f: () => Promise<Msg>): Promise<Msg> {
  try { return await f(); } catch (e) { if (e instanceof EnclaveError) throw new HostError(e.code, e.message, e.code === "NH_ENCLAVE_UNAVAILABLE" ? 503 : 400); throw e; }
}

/**
 * `POST /operator/handoff` (operator): an identity or template handoff from a local instance (`from_instance`, or any)
 * to `to_instance` (R5). The enclaves check everything; the host only names the two ends.
 */
export async function handleOperatorHandoff(ctx: HostContext, authorization: string | undefined, body: Record<string, unknown>): Promise<{ status: string }> {
  requireOperator(ctx, authorization);
  const scope = body?.["scope"], to = body?.["to_instance"], card = body?.["card"];
  if ((scope !== "identity" && scope !== "template") || typeof to !== "string" || typeof card !== "string") throw new HostError("MISSING_FIELD", "scope (identity | template), card and to_instance are required");
  const from = typeof body["from_instance"] === "string" ? ctx.instances.get(body["from_instance"]) : undefined;
  const session = from && !from.closed ? from : liveSession(ctx);
  await viaEnclave(() => session.call("start_handoff", { scope, card, to_instance: to, ...(typeof body["template"] === "string" ? { template: body["template"] } : {}) }));
  if (scope === "identity") ctx.instanceCards.set(to, card);
  return { status: "started" };
}

/**
 * `POST /operator/template-seed` (operator; step 6.4): the first enclave serving a derived-card template `T` seeds the template's
 * `dup_tag` key (generation 0). Every other enclave that serves `T` gets it by template-scope handoff (`/operator/handoff`). The
 * enclave refuses to seed twice. The host only names the template, the notary card and the period length.
 */
export async function handleOperatorSeedTemplate(ctx: HostContext, authorization: string | undefined, body: Record<string, unknown>): Promise<{ status: string; generation: number; period: number }> {
  requireOperator(ctx, authorization);
  const template = body?.["template"], card = body?.["notary_card"], period = body?.["nullifier_period"];
  if (typeof template !== "string" || typeof card !== "string" || typeof period !== "string") throw new HostError("MISSING_FIELD", "template, notary_card and nullifier_period are required");
  const from = typeof body["instance"] === "string" ? ctx.instances.get(body["instance"]) : undefined;
  const session = from && !from.closed ? from : liveSession(ctx);
  const r = await viaEnclave(() => session.call("seed_template", { template, notary_card: card, nullifier_period: period }));
  return { status: "seeded", generation: Number(r["generation"]), period: Number(r["period"]) };
}

/** `POST /operator/shutdown` (operator): the named local instance tells its peers it stops and erases its job keys (R5). */
export async function handleOperatorShutdown(ctx: HostContext, authorization: string | undefined, body: Record<string, unknown>): Promise<{ status: string }> {
  requireOperator(ctx, authorization);
  const s = typeof body?.["instance"] === "string" ? ctx.instances.get(body["instance"]) : undefined;
  if (!s || s.closed) throw new HostError("NH_ENCLAVE_UNAVAILABLE", "no such local instance", 404);
  await viaEnclave(() => s.call("shutdown"));
  return { status: "stopped" };
}
