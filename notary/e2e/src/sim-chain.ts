/**
 * The simulated chain for the step 5.5 end-to-end run: the card registry, IPFS, block headers and EAS, as one HTTP
 * service. Test use only. It stands where Arbitrum One, Kubo and EAS stand in production (Phase 7 wires those), so the
 * host reaches it through the same service interfaces (`notary/host/src/services.ts`), and the driver reads it as a
 * wallet or verifier would read the chain.
 *
 * Blocks: one is mined every `BLOCK_MS` (default 1000) and on every write, so each write lands in its own block with
 * that block's timestamp. Headers are Ethereum-format RLP; hash = keccak256(rlp) (runtime §13).
 *
 *   PUT  /ipfs                       raw bytes → { cid }              GET /ipfs/:cid → bytes
 *   POST /registry/card              { address, policy, press, head_cid } → { block, timestamp }
 *   GET  /registry/card/:address     → { head_cid, events: [{ cid, timestamp }], policy, press }
 *   POST /registry/subcard           { master_card, sub_card, sub_card_doc_cid, active }
 *   GET  /registry/subcard/:address  → { master_card_address, sub_card_doc_cid, active }
 *   POST /deliver                    a routing envelope the host delivered   GET /delivered → all of them
 *   POST /registry/policy            { policy_id, address }  (the policy's own card)
 *   GET  /registry/events?policy=P   → { events: RegistryEvent[], subcards: SubCardEvent[], block, policy_head }
 *   GET  /headers?after=N            → [{ number, hash, header_rlp, timestamp }]   GET /block/:number → one header
 *   POST /eas                        { scope_id, seq, record_cid } → { tx_hash, block, timestamp }   GET /eas/:scope
 *   POST /tx                         chain_submit payloads, recorded → { tx_hash }
 *   GET  /world                      the registry and IPFS as a `CardWorld`
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";
import { toRlp, bytesToHex, hexToBytes, numberToHex } from "viem";
import { p256 } from "@noble/curves/p256";
import { cidOfBytes, canonicalNotary, b64uDecode } from "@membership-card-protocol/verifier/notary";

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const iso = (ms: number) => new Date(ms).toISOString();

export interface Block { number: number; hash: string; header_rlp: string; timestamp: number }
interface RegEvent { kind: "CardRegistered" | "CardHeadUpdated"; policyAddress: string; cardAddress: string; headCid: string; pressAddress: string; block: number; timestamp: string }
interface SubEvent { masterCard: string; subCard: string; subCardDocCid: string; active: boolean; block: number }

export function createSimChain(o: { blockMs?: number; startMs?: number } = {}) {
  const ipfs = new Map<string, Uint8Array>();
  const blocks: Block[] = [];
  const events: RegEvent[] = [];
  const subs: SubEvent[] = [];
  const anchors = new Map<string, { seq: number; record_cid: string; timestamp: number; block: number; tx_hash: string }[]>();
  const txs: unknown[] = [];
  /** `notary_output` routing envelopes the host delivered (step 6.1) */
  const delivered: unknown[] = [];
  /** policy id → the address of the policy's own card (stands for the registry's `RegisterPolicy`) */
  const policyCards = new Map<string, string>();
  /** `PressAuthorizations`: "policyHex:pressHex" → the press's secp256r1 key (x||y), next sequence. Test setup stands for `AuthorizePress`. */
  const pressAuths = new Map<string, { key: Uint8Array; next: number; active: boolean }>();
  let lastTs = 0;

  function mine(): Block {
    const parent = blocks.length ? hexToBytes(blocks[blocks.length - 1]!.hash as `0x${string}`) : new Uint8Array(32);
    const number = blocks.length + 1;
    // strictly increasing whole seconds, at or after wall time
    const ts = Math.max(Math.floor((o.startMs ?? Date.now()) / 1000), Math.floor(Date.now() / 1000), lastTs + 1);
    lastTs = ts;
    const z = (n: number) => bytesToHex(new Uint8Array(n));
    const rlp = toRlp([bytesToHex(parent), z(32), z(20), bytesToHex(keccak_256(new TextEncoder().encode(`state-${number}`))), z(32), z(32), z(256),
      numberToHex(1), numberToHex(number), numberToHex(30_000_000), "0x", numberToHex(ts), "0x", z(32), z(8)], "bytes");
    const b: Block = { number, hash: bytesToHex(keccak_256(rlp)), header_rlp: b64u(rlp), timestamp: ts };
    blocks.push(b);
    return b;
  }
  mine();
  const timer = setInterval(mine, o.blockMs ?? 1000);
  timer.unref();

  /** registry_contract §4.15 with the §6.1 gate (6.5): see `submitTx`. */
  function batchGate(m: { op: string; payload: Record<string, unknown>; signature: string; calldata: Record<string, unknown> }): { tx_hash: string } | { failed: string } {
    const pl = m.payload;
    const hexOf = (s: unknown) => Buffer.from(b64uDecode(String(s))).toString("hex");
    const text = (s: unknown) => new TextDecoder().decode(b64uDecode(String(s)));
    const same = (a: unknown, b: unknown) => Buffer.from(canonicalNotary(a as never)).equals(Buffer.from(canonicalNotary(b as never)));
    try {
      if (pl["op"] !== "batch_update_card_heads") return { failed: "OP_MISMATCH" };
      const policyHex = hexOf(pl["policy_address"]), pressHex = hexOf(pl["press_address"]);
      const auth = pressAuths.get(`${policyHex}:${pressHex}`);
      if (!auth || !auth.active) return { failed: "PRESS_NOT_AUTHORIZED" };
      const digest = keccak_256(canonicalNotary(pl as never));
      if (!p256.verify(b64uDecode(m.signature), digest, new Uint8Array([4, ...auth.key]), { prehash: false, lowS: false })) return { failed: "PRESS_SIGNATURE_INVALID" };
      if (pl["sequence"] !== auth.next) return { failed: "SEQUENCE_MISMATCH" };
      for (const f of ["policy_address", "press_address", "updates"]) if (m.calldata?.[f] === undefined || !same(m.calldata[f], pl[f])) return { failed: "PAYLOAD_CALLDATA_MISMATCH" };
      const ups = pl["updates"] as { card_address: string; prev_log_cid: string; new_log_cid: string }[];
      if (!Array.isArray(ups) || ups.length === 0 || ups.length > 100) return { failed: "BATCH_SIZE_INVALID" };
      const policy = [...policyCards].find(([, addr]) => addr === policyHex)?.[0];
      if (!policy) return { failed: "POLICY_UNKNOWN" };
      for (const u of ups) {
        const c = api.card(hexOf(u.card_address));
        if (!c) return { failed: "CARD_NOT_FOUND" };
        if (c.policy !== policy) return { failed: "BATCH_ITEM_INVALID" };
        if (c.head_cid !== text(u.prev_log_cid)) return { failed: "STALE_PREV_CID" };
      }
      auth.next += 1;
      for (const u of ups) api.registerCard({ address: hexOf(u.card_address), policy, press: pressHex, head_cid: text(u.new_log_cid) });
      return { tx_hash: bytesToHex(digest) };
    } catch (e) { return { failed: `MALFORMED: ${(e as Error).message}` }; }
  }

  const api: any = {
    ipfs, blocks, events, subs, anchors, txs, mine, policyCards, delivered,
    pin(bytes: Uint8Array) { const cid = cidOfBytes(bytes); ipfs.set(cid, bytes); return cid; },
    registerCard(c: { address: string; policy: string; press: string; head_cid: string }) {
      const b = mine();
      const kind = events.some((e) => e.cardAddress === c.address) ? "CardHeadUpdated" : "CardRegistered";
      events.push({ kind, policyAddress: c.policy, cardAddress: c.address, headCid: c.head_cid, pressAddress: c.press, block: b.number, timestamp: iso(b.timestamp * 1000) });
      return { block: b.number, timestamp: iso(b.timestamp * 1000) };
    },
    card(address: string) {
      const evs = events.filter((e) => e.cardAddress === address);
      if (!evs.length) return null;
      const last = evs[evs.length - 1]!;
      return { head_cid: last.headCid, events: evs.map((e) => ({ cid: e.headCid, timestamp: e.timestamp })), policy: last.policyAddress, press: last.pressAddress };
    },
    registerSub(s: { master_card: string; sub_card: string; sub_card_doc_cid: string; active: boolean }) {
      const b = mine();
      subs.push({ masterCard: s.master_card, subCard: s.sub_card, subCardDocCid: s.sub_card_doc_cid, active: s.active, block: b.number });
      return { block: b.number };
    },
    sub(address: string) {
      const s = [...subs].reverse().find((x) => x.subCard === address);
      return s ? { master_card_address: s.masterCard, sub_card_doc_cid: s.subCardDocCid, active: s.active } : null;
    },
    anchor(a: { scope_id: string; seq: number; record_cid: string }) {
      const b = mine();
      const tx = bytesToHex(sha256(new TextEncoder().encode(`eas-${a.scope_id}-${a.seq}-${a.record_cid}`)));
      const list = anchors.get(a.scope_id) ?? [];
      list.push({ seq: a.seq, record_cid: a.record_cid, timestamp: b.timestamp, block: b.number, tx_hash: tx });
      anchors.set(a.scope_id, list);
      return { tx_hash: tx, block: b.number, timestamp: b.timestamp };
    },
    /** The whole registry and IPFS as a `CardWorld` (`verifier/notary` `contributor.ts`), as a chain reader sees it. */
    world() {
      const cards: Record<string, { log_head_cid: string; policy_address: string; last_press_address: string; events: { cid: string; timestamp: string }[] }> = {};
      for (const e of events) {
        const c = cards[e.cardAddress] ?? { log_head_cid: e.headCid, policy_address: e.policyAddress, last_press_address: e.pressAddress, events: [] };
        c.log_head_cid = e.headCid; c.last_press_address = e.pressAddress; c.events.push({ cid: e.headCid, timestamp: e.timestamp });
        cards[e.cardAddress] = c;
      }
      const subcards: Record<string, { master_card_address: string; sub_card_doc_cid: string; active: boolean }> = {};
      for (const s of subs) subcards[s.subCard] = { master_card_address: s.masterCard, sub_card_doc_cid: s.subCardDocCid, active: s.active };
      const ip: Record<string, string> = {};
      for (const [k, v] of ipfs) ip[k] = b64u(v);
      return { cards, subcards, ipfs: ip };
    },
    authorizePress(policyHex: string, pressHex: string, keyXY: Uint8Array) { pressAuths.set(`${policyHex}:${pressHex}`, { key: keyXY, next: 0, active: true }); },
    pressAuth(policyHex: string, pressHex: string) {
      const a = pressAuths.get(`${policyHex}:${pressHex}`);
      return a ? { next_sequence: a.next, active: a.active, press_public_key: b64u(a.key) } : null;
    },
    /**
     * `chain_submit` payloads. `register_card` goes through the write gate of registry_contract §4.1 and §6.1: press
     * authorized and active (3), signature over keccak256(payload) (4), sequence (5), every signed field equal to the
     * calldata in unpadded base64url (8, E-49), no re-registration. `batch_update_card_heads` (§4.15, step 6.5) goes
     * through the same gate, with the `updates` list equal to the calldata's in order, every card under the policy and
     * its `prev_log_cid` its current head; then every head moves. Other ops are only recorded.
     */
    submitTx(m: { op: string; payload: Record<string, string | number>; signature: string; calldata: Record<string, string> }): { tx_hash: string } | { failed: string } {
      txs.push(m);
      if (m.op === "batch_update_card_heads") return batchGate(m as never);
      if (m.op !== "register_card") return { tx_hash: bytesToHex(keccak_256(canonicalNotary(m.payload as never))) };
      const pl = m.payload;
      const hexOf = (s: unknown) => Buffer.from(b64uDecode(String(s))).toString("hex");
      try {
        if (pl["op"] !== "register_card") return { failed: "OP_MISMATCH" };
        const policyHex = hexOf(pl["policy_address"]), pressHex = hexOf(pl["press_address"]);
        const auth = pressAuths.get(`${policyHex}:${pressHex}`);
        if (!auth || !auth.active) return { failed: "PRESS_NOT_AUTHORIZED" };
        const digest = keccak_256(canonicalNotary(pl as never));
        if (!p256.verify(b64uDecode(m.signature), digest, new Uint8Array([4, ...auth.key]), { prehash: false, lowS: false })) return { failed: "PRESS_SIGNATURE_INVALID" };
        if (pl["sequence"] !== auth.next) return { failed: "SEQUENCE_MISMATCH" };
        for (const f of ["card_address", "initial_log_cid", "policy_address", "press_address"]) {
          const v = m.calldata?.[f];
          if (typeof v !== "string" || v !== pl[f] || b64u(b64uDecode(v)) !== v) return { failed: "PAYLOAD_CALLDATA_MISMATCH" };
        }
        const card = hexOf(pl["card_address"]);
        if (events.some((e) => e.cardAddress === card)) return { failed: "CARD_EXISTS" };
        const policy = [...policyCards].find(([, addr]) => addr === policyHex)?.[0];
        if (!policy) return { failed: "POLICY_UNKNOWN" };
        auth.next += 1;
        api.registerCard({ address: card, policy, press: pressHex, head_cid: new TextDecoder().decode(b64uDecode(String(pl["initial_log_cid"]))) });
        return { tx_hash: bytesToHex(digest) };
      } catch (e) { return { failed: `MALFORMED: ${(e as Error).message}` }; }
    },
    stop() { clearInterval(timer); },
  };
  return api;
}

export type SimChain = ReturnType<typeof createSimChain>;

async function body(req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of req) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

export function serveSimChain(chain: SimChain, port: number, host = "0.0.0.0") {
  const send = (res: ServerResponse, status: number, v: unknown) => {
    if (v instanceof Uint8Array) { res.writeHead(status, { "content-type": "application/octet-stream" }); res.end(Buffer.from(v)); return; }
    res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v));
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      const p = url.pathname.split("/").filter(Boolean);
      const m = req.method ?? "GET";
      if (m === "GET" && p[0] === "time") return send(res, 200, { ms: Date.now(), block: chain.blocks.length });
      if (m === "PUT" && p[0] === "ipfs") return send(res, 200, { cid: chain.pin(new Uint8Array(await body(req))) });
      if (m === "GET" && p[0] === "ipfs" && p[1]) { const b = chain.ipfs.get(p[1]); return b ? send(res, 200, b) : send(res, 404, { error: "not found" }); }
      if (m === "POST" && p[0] === "registry" && p[1] === "card") return send(res, 200, chain.registerCard(JSON.parse((await body(req)).toString())));
      if (m === "GET" && p[0] === "registry" && p[1] === "card" && p[2]) { const c = chain.card(p[2]); return c ? send(res, 200, c) : send(res, 404, { error: "not found" }); }
      if (m === "POST" && p[0] === "registry" && p[1] === "subcard") return send(res, 200, chain.registerSub(JSON.parse((await body(req)).toString())));
      if (m === "GET" && p[0] === "registry" && p[1] === "subcard" && p[2]) { const s = chain.sub(p[2]); return s ? send(res, 200, s) : send(res, 404, { error: "not found" }); }
      if (m === "GET" && p[0] === "registry" && p[1] === "events") {
        const policy = url.searchParams.get("policy") ?? "";
        const addr = chain.policyCards.get(policy);
        return send(res, 200, { events: chain.events.filter((e) => e.policyAddress === policy), subcards: chain.subs, block: chain.blocks.length, policy_head: addr ? chain.card(addr)?.head_cid ?? null : null });
      }
      if (m === "POST" && p[0] === "registry" && p[1] === "policy") { const b = JSON.parse((await body(req)).toString()) as { policy_id: string; address: string }; chain.policyCards.set(b.policy_id, b.address); return send(res, 200, { ok: true }); }
      if (m === "POST" && p[0] === "deliver") { chain.delivered.push(JSON.parse((await body(req)).toString())); return send(res, 200, { ok: true }); }
      if (m === "GET" && p[0] === "delivered") return send(res, 200, chain.delivered);
      if (m === "GET" && p[0] === "world") return send(res, 200, chain.world());
      if (m === "GET" && p[0] === "headers") { const after = Number(url.searchParams.get("after") ?? 0); return send(res, 200, chain.blocks.filter((b) => b.number > after)); }
      if (m === "GET" && p[0] === "block" && p[1]) { const b = chain.blocks[Number(p[1]) - 1]; return b ? send(res, 200, b) : send(res, 404, { error: "not found" }); }
      if (m === "POST" && p[0] === "eas") return send(res, 200, chain.anchor(JSON.parse((await body(req)).toString())));
      if (m === "GET" && p[0] === "eas" && p[1]) return send(res, 200, chain.anchors.get(p[1]) ?? []);
      if (m === "POST" && p[0] === "tx") { const r = chain.submitTx(JSON.parse((await body(req)).toString())); return send(res, "failed" in r ? 409 : 200, r); }
      if (m === "POST" && p[0] === "registry" && p[1] === "press-auth") { const b = JSON.parse((await body(req)).toString()) as { policy: string; press: string; key: string }; chain.authorizePress(b.policy, b.press, b64uDecode(b.key)); return send(res, 200, { ok: true }); }
      if (m === "GET" && p[0] === "registry" && p[1] === "press" && p[2] && p[3]) { const a = chain.pressAuth(p[2], p[3]); return a ? send(res, 200, a) : send(res, 404, { error: "not found" }); }
      if (m === "GET" && p[0] === "registry" && p[1] === "protocol-version") return send(res, 200, { version: "0.1" });
      return send(res, 404, { error: "no route" });
    } catch (e) { return send(res, 500, { error: (e as Error).message }); }
  });
  return new Promise<typeof server>((resolve) => server.listen(port, host, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env["SIM_CHAIN_PORT"] ?? 8545);
  const chain = createSimChain({ blockMs: Number(process.env["BLOCK_MS"] ?? 1000) });
  await serveSimChain(chain, port);
  console.log(`sim-chain listening on :${port}`);
}
