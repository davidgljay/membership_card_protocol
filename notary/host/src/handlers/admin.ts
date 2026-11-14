/**
 * Operator-authenticated genesis routes, peer relay and health (notary_host.md §5). `/genesis*` are direct, for
 * the operator only; the mechanism (a shared bearer token, `NOTARY_ADMIN_TOKEN`) is erratum E18.
 */
import { HostError } from "../context.js";
import type { HostContext } from "../context.js";
import { EnclaveError } from "../enclave/transport.js";
import { liveSession } from "./jobs.js";
import { handlePeerPost } from "./replication.js";

import { requireOperator } from "../context.js";
export { requireOperator };

async function viaEnclave<T>(f: () => Promise<T>): Promise<T> {
  try { return await f(); } catch (e) { if (e instanceof EnclaveError) throw new HostError(e.code, e.message, e.code === "NH_ENCLAVE_UNAVAILABLE" ? 503 : 400); throw e; }
}

/** `POST /genesis`: starts notary genesis; returns the genesis request fields and attestation. */
export async function handleGenesis(ctx: HostContext, authorization: string | undefined, body: { request?: unknown }) {
  requireOperator(ctx, authorization);
  if (!body?.request) throw new HostError("MISSING_FIELD", "request is required");
  const r = await viaEnclave(() => liveSession(ctx).call("genesis", { request: body.request }));
  // this host serves the card it just created: no restart, no configuration (5.7, Q4)
  if (typeof r["notary_card"] === "string" && /^[0-9a-f]{64}$/.test(r["notary_card"])) {
    await ctx.cards.add(r["notary_card"]);
    const inst = [...ctx.instances].find(([, s]) => s === liveSession(ctx))?.[0];
    if (inst) ctx.instanceCards.set(inst, r["notary_card"]);
  }
  // `request` and `notary_card` (runtime §9, E24): the completed request is what the notary card's `genesis_request` names
  return { id_pubkey: r["id_pubkey"], chain_pubkey: r["chain_pubkey"], attestation: r["attestation"], request: r["request"], notary_card: r["notary_card"] };
}

/** `POST /genesis/countersign`: passes the policy holder's notary card offer to the enclave. */
export async function handleCountersign(ctx: HostContext, authorization: string | undefined, body: { offer?: unknown }) {
  requireOperator(ctx, authorization);
  if (!body?.offer) throw new HostError("MISSING_FIELD", "offer is required");
  const r = await viaEnclave(() => liveSession(ctx).call("countersign_notary_card", { offer: body.offer }));
  return { offer: r["offer"] };
}

/** `POST /peer`: peer envelopes for a local instance, and the other 6.3 kinds (`replication.ts`). Hosts see only signed or sealed bytes. */
export async function handlePeer(ctx: HostContext, body: Record<string, unknown>): Promise<unknown> {
  return handlePeerPost(ctx, body);
}

export function handleHealth(ctx: HostContext): { status: "ok" | "degraded"; attested_enclaves: number; instances: string[] } {
  const n = [...ctx.sessions.values()].filter((s) => !s.closed).length;
  // instance ids are public (they name every job-log record's writer)
  const instances = [...ctx.instances].filter(([, s]) => !s.closed).map(([i]) => i);
  return { status: n > 0 ? "ok" : "degraded", attested_enclaves: n, instances };
}
