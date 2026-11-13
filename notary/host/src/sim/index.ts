/**
 * Clients for the simulated chain (`notary/e2e/src/sim-chain.ts`), used only with `CHAIN_PROVIDER=sim` (step 5.5,
 * docker-compose.sim.yml). They implement the same interfaces the Phase 7 chain, EAS and Kubo clients will, so the
 * host code above them is the code that runs in production. Nothing here decides anything: the enclave re-checks
 * every object it gets (notary_host.md §2).
 */
import { createDecipheriv } from "node:crypto";
import { hkdf } from "@noble/hashes/hkdf";
import { sha3_256 } from "@noble/hashes/sha3";
import { b64uDecode, canonicalNotary } from "@membership-card-protocol/wallet-sdk/notary-types";
import type { NotarySection } from "@membership-card-protocol/verifier/notary";
import type { ChainFeed, ChainReader, ChainSubmitter, EasAnchorer, IpfsService, PolicyReader } from "../services.js";

type Json = Record<string, unknown>;

export function simChain(baseUrl: string) {
  const base = baseUrl.replace(/\/$/, "");
  const get = async (path: string): Promise<unknown | null> => { const r = await fetch(`${base}${path}`); if (r.status === 404) return null; if (!r.ok) throw new Error(`sim-chain ${path}: ${r.status}`); return r.json(); };
  const post = async (path: string, body: unknown): Promise<Json> => {
    const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`sim-chain ${path}: ${r.status}`);
    return (await r.json()) as Json;
  };

  const ipfs: IpfsService = {
    async pin(bytes) { const r = await fetch(`${base}/ipfs`, { method: "PUT", body: Buffer.from(bytes) }); if (!r.ok) throw new Error(`sim-chain pin: ${r.status}`); return String(((await r.json()) as Json)["cid"]); },
    async fetch(cid) { const r = await fetch(`${base}/ipfs/${cid}`); return r.ok ? new Uint8Array(await r.arrayBuffer()) : null; },
  };
  const eas: EasAnchorer = { async anchor(a) { const r = await post("/eas", { scope_id: a.scopeId, seq: a.seq, record_cid: a.recordCid }); return { txHash: String(r["tx_hash"]) }; } };
  const submitter: ChainSubmitter = { async submit(s) { const r = await post("/tx", s); return { txHash: String(r["tx_hash"]) }; } };
  const chain: ChainReader = {
    // notary_host.md §8 shapes: `card_head:` → { head_cid, events }; `subcard:` → { master_card_address, sub_card_doc_cid, active }
    async cardHead(address) { const c = (await get(`/registry/card/${address}`)) as Json | null; return c ? canonicalNotary({ events: c["events"], head_cid: c["head_cid"] }) : null; },
    pressAuth: async () => null,
    subcard: (address) => get(`/registry/subcard/${address}`),
    events: async () => null,
  };
  const feed: ChainFeed = {
    headersAfter: async (n) => ((await get(`/headers?after=${n}`)) ?? []) as Awaited<ReturnType<ChainFeed["headersAfter"]>>,
    async registry(policy) {
      const r = (await get(`/registry/events?policy=${encodeURIComponent(policy)}`)) as Awaited<ReturnType<ChainFeed["registry"]>> | null;
      return r ?? { events: [], subcards: [], block: 0 };
    },
  };
  /** Job intake's policy read (a courtesy check: the enclave runs algorithm R itself). */
  const policies: PolicyReader = {
    async notary(policyId, stateCid) {
      const plain = await ipfs.fetch(policyId);
      if (!plain) return null;
      let genesis: Json;
      try { genesis = JSON.parse(new TextDecoder().decode(plain)) as Json; } catch { return null; }
      const pub = typeof genesis["recipient_pubkey"] === "string" ? b64uDecode(genesis["recipient_pubkey"] as string) : null;
      if (!pub) return null;
      const key = hkdf(sha3_256, pub, undefined, new TextEncoder().encode("card-content-v1"), 32);
      const open = async (cid: string): Promise<Json | null> => {
        const b = await ipfs.fetch(cid);
        if (!b) return null;
        try {
          const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
          d.setAuthTag(b.subarray(b.length - 16));
          return JSON.parse(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString()) as Json;
        } catch { try { return JSON.parse(new TextDecoder().decode(b)) as Json; } catch { return null; } }
      };
      const state = await open(stateCid);
      if (!state) return null;
      const doc: Json = { ...genesis, ...((state["card_state"] as Json | undefined) ?? (state["entry_type"] ? {} : state)) };
      return { notary: doc["notary"] as NotarySection, approvedNotaries: (doc["approved_notaries"] as string[] | undefined) ?? [] };
    },
  };
  return { ipfs, eas, submitter, chain, feed, policies };
}
