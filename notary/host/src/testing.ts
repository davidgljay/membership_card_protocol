/** In-memory implementations of the host's services, for tests and local runs. */
import { createMockIpfs } from "./ipfs/index.js";
import type { ChainReader, ChainSubmitter, DeliveryClient, EasAnchorer, Monitor, PeerClient, PolicyReader, ReplicaStarter } from "./services.js";

export function memoryServices() {
  const anchors: { scopeId: string; seq: number; recordCid: string }[] = [];
  const alerts: { level: string; code: string; counts?: Record<string, number> }[] = [];
  const delivered: unknown[] = [];
  const peerSends: { url: string; body: unknown }[] = [];
  const started: { job: string | null; card: string | null }[] = [];
  const submitted: unknown[] = [];
  const state = { failAnchor: false, failPeer: false, failDelivery: false, failSubmit: false, noReplica: false };
  const eas: EasAnchorer = { async anchor(a) { if (state.failAnchor) throw new Error("rpc down"); anchors.push(a); return { txHash: `0xtx${anchors.length}` }; } };
  const submitter: ChainSubmitter = { async submit(s) { submitted.push(s); return state.failSubmit ? { failed: "revert" } : { txHash: "0xchain" + submitted.length }; } };
  const policies: PolicyReader & { set(id: string, v: Awaited<ReturnType<PolicyReader["notary"]>>): void } = (() => {
    const m = new Map<string, Awaited<ReturnType<PolicyReader["notary"]>>>();
    return { set: (id, v) => { m.set(id, v); }, notary: async (id) => m.get(id) ?? null };
  })();
  const chain: ChainReader = { cardHead: async () => new Uint8Array([1]), pressAuth: async () => ({ active: true }), subcard: async () => ({}), events: async () => [] };
  const peers: PeerClient = { async send(url, body) { if (state.failPeer) throw new Error("peer down"); peerSends.push({ url, body }); } };
  const delivery: DeliveryClient = { async deliver(e) { if (state.failDelivery) throw new Error("routing down"); delivered.push(e); } };
  const replicas: ReplicaStarter = { async start(job, card) { if (state.noReplica) throw new Error("no capacity"); started.push({ job, card }); } };
  const monitor: Monitor = { async alert(level, code, counts) { alerts.push({ level, code, ...(counts ? { counts } : {}) }); } };
  return { ipfs: createMockIpfs(), eas, submitter, policies, chain, peers, delivery, replicas, monitor, anchors, alerts, delivered, peerSends, started, submitted, state };
}
