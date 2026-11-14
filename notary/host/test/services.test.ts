import { createContext } from "../src/context.js";
import { describe, it, expect } from "vitest";
import { buildSnapshot, buildUpdates } from "../src/chain/snapshots.js";
import type { RegistryEvent, SubCardEvent } from "../src/chain/snapshots.js";
import { sanitizeAlert, webhookMonitor } from "../src/monitoring/index.js";
import { handleCountersign, handleGenesis, handleHealth, handlePeer, requireOperator } from "../src/handlers/admin.js";
import { blobStore, logStore } from "../src/storage/index.js";
import { createInMemoryKv } from "../src/kv.js";
import { HostError } from "../src/context.js";
import { harness } from "./helpers.js";

const POL = "pol-1";
const ev = (card: string, head: string, block: number, kind: RegistryEvent["kind"] = "CardHeadUpdated", policy = POL): RegistryEvent => ({ kind, policyAddress: policy, cardAddress: card, headCid: head, pressAddress: "press", block, timestamp: `2027-01-01T00:00:${String(block).padStart(2, "0")}.000Z` });
const heads = new Map([["h1", new Uint8Array([1])], ["h2", new Uint8Array([2])], ["h3", new Uint8Array([3])], ["h4", new Uint8Array([4])]]);

describe("policy snapshots and updates are NEVER filtered (notary_host.md §8)", () => {
  const events = [ev("c1", "h1", 1, "CardRegistered"), ev("c2", "h2", 2, "CardRegistered"), ev("c1", "h3", 5), ev("c3", "h4", 6, "CardRegistered"), ev("other", "hx", 3, "CardRegistered", "pol-2")];
  it("a snapshot holds every card under the policy with its CURRENT head, in address order, and nothing from other policies", () => {
    const s = buildSnapshot(POL, events, [], heads, 10);
    const t = (b: number) => `2027-01-01T00:00:${String(b).padStart(2, "0")}.000Z`;
    expect(s.entries).toEqual([
      { address: "c1", head_cid: "h3", last_press: "press", events: [{ cid: "h1", timestamp: t(1) }, { cid: "h3", timestamp: t(5) }] },
      { address: "c2", head_cid: "h2", last_press: "press", events: [{ cid: "h2", timestamp: t(2) }] },
      { address: "c3", head_cid: "h4", last_press: "press", events: [{ cid: "h4", timestamp: t(6) }] },
    ]); // each card's full head history with block timestamps (Stage 4 provenance; E30)
    expect(s.heads.map((h) => h.cid)).toEqual(["h3", "h2", "h4"]);
    expect(Buffer.from(s.heads[0]!.bytes, "base64url")).toEqual(Buffer.from([3]));
  });
  it("the snapshot is a function of the registry and the block only: it takes no list of cards of interest", () => {
    expect(buildSnapshot.length).toBe(5); // (policy, events, subcards, heads, atBlock): there is no filter parameter
    expect(buildSnapshot(POL, events, [], heads, 10)).toEqual(buildSnapshot(POL, [...events].reverse(), [], heads, 10)); // independent of event order
  });
  it("respects the snapshot block; a card registered later is absent", () => {
    expect(buildSnapshot(POL, events, [], heads, 2).entries.map((e) => e.address)).toEqual(["c1", "c2"]);
  });
  it("includes sub-card registrations only for master cards in the set, with their current active flag", () => {
    const subs: SubCardEvent[] = [{ masterCard: "c1", subCard: "s1", subCardDocCid: "bafkreisub1", active: true, block: 3 }, { masterCard: "c1", subCard: "s1", subCardDocCid: "bafkreisub1", active: false, block: 7 }, { masterCard: "zz", subCard: "s9", subCardDocCid: "bafkreisub9", active: true, block: 3 }];
    expect(buildSnapshot(POL, events, subs, heads, 10).subcards).toEqual([{ master_card: "c1", sub_card: "s1", sub_card_doc_cid: "bafkreisub1", active: false }]);
  });
  it("updates since a block are every registration and head change under the policy, in order, unfiltered", () => {
    const u = buildUpdates(POL, events, 1, heads);
    expect(u.map((x) => `${x.card_address}:${x.head_cid}:${x.block}`)).toEqual(["c2:h2:2", "c1:h3:5", "c3:h4:6"]);
  });
});

describe("monitoring (notary_host.md §13): alerts never carry job data", () => {
  it("only a level, a safe code and integer counts survive", () => {
    expect(sanitizeAlert("warn", "close_mismatch", { replicas: 2 })).toEqual({ level: "warn", code: "close_mismatch", counts: { replicas: 2 } });
    expect(sanitizeAlert("weird", "has spaces and a job_hash=abc", { "bad key!": 1, ok_key: 1.5, fine: 3 })).toEqual({ level: "error", code: "unknown", counts: { fine: 3 } });
  });
  it("the webhook receives the sanitized body only and a failing webhook never throws", async () => {
    const sent: unknown[] = [];
    await webhookMonitor("https://hook", async (_u, b) => { sent.push(b); }).alert("info", "enclaves_attested", { n: 3 });
    expect(sent).toEqual([{ level: "info", code: "enclaves_attested", counts: { n: 3 } }]);
    await webhookMonitor("https://hook", async () => { throw new Error("down"); }).alert("info", "x");
    await webhookMonitor(undefined, async () => { throw new Error("never"); }).alert("info", "x");
  });
});

describe("operator-authenticated routes, peer relay and health", () => {
  const TOKEN = "t".repeat(40);
  it("genesis routes need the operator token; wrong or missing tokens are refused with 401", async () => {
    const h = await harness();
    for (const a of [undefined, "", "Bearer wrong", `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(1)}`]) {
      await expect(handleGenesis(h.ctx, a, { request: {} })).rejects.toMatchObject({ code: "NH_UNAUTHORIZED", status: 401 });
    }
    expect(() => requireOperator(h.ctx, `Bearer ${TOKEN}`)).not.toThrow();
    expect(h.enclave.received.some((m) => m.kind === "genesis")).toBe(false);
  });
  it("genesis and countersign are forwarded to an enclave and return its answer", async () => {
    const h = await harness();
    const g = await handleGenesis(h.ctx, `Bearer ${TOKEN}`, { request: { nonce: "n" } });
    expect(g).toMatchObject({ id_pubkey: "TU9DS19JRA" });
    expect(h.enclave.received.find((m) => m.kind === "genesis")!["request"]).toEqual({ nonce: "n" });
    expect(await handleCountersign(h.ctx, `Bearer ${TOKEN}`, { offer: { a: 1 } })).toEqual({ offer: { a: 1 } });
    await expect(handleGenesis(h.ctx, `Bearer ${TOKEN}`, {} as never)).rejects.toMatchObject({ code: "MISSING_FIELD" });
  });
  it("a card created through /genesis is served at once and after a restart, with no configuration (Q4)", async () => {
    const h = await harness({}, { cardAddresses: [] });
    expect(h.ctx.cards.all()).toEqual([]);
    await handleGenesis(h.ctx, `Bearer ${TOKEN}`, { request: { nonce: "n" } });
    const card = "cd".repeat(32);
    expect(h.ctx.cards.all()).toEqual([card]);
    // a new context over the same KV and an empty configuration serves it after load()
    const again = createContext({ ...h.ctx, config: { ...h.ctx.config, NOTARY_CARD_ADDRESSES: [] } });
    expect(again.cards.all()).toEqual([]);
    await again.cards.load();
    expect(again.cards.all()).toEqual([card]);
  });
  it("peer relay forwards signed or sealed bytes to the named local instance only", async () => {
    const h = await harness();
    const inst = [...h.ctx.instances.keys()][0]!;
    expect(await handlePeer(h.ctx, { to_instance: inst, from_instance: "remote", bytes: "QUJD" })).toEqual({ delivered: true });
    expect(h.enclave.received.at(-1)).toMatchObject({ kind: "peer_message", from_instance: "remote", bytes: "QUJD" });
    await expect(handlePeer(h.ctx, { to_instance: "nobody", from_instance: "r", bytes: "x" })).rejects.toMatchObject({ code: "NH_ENCLAVE_UNAVAILABLE" });
    await expect(handlePeer(h.ctx, {} as never)).rejects.toBeInstanceOf(HostError);
  });
  it("health reports the number of attested enclaves", async () => {
    const h = await harness();
    expect(handleHealth(h.ctx)).toEqual({ status: "ok", attested_enclaves: 1 });
    h.session.closed = true;
    expect(handleHealth(h.ctx)).toEqual({ status: "degraded", attested_enclaves: 0 });
  });
});

describe("storage (notary_host.md §7)", () => {
  it("the log store appends records and records anchor transaction hashes; it is permanent (no expiry)", async () => {
    const kv = createInMemoryKv(); const l = logStore(kv);
    await l.append("scope", { seq: 0, record_cid: "a" }); await l.append("scope", { seq: 1, record_cid: "b" });
    await l.setAnchor("scope", 1, "0xtx");
    expect(await l.list("scope")).toEqual([{ seq: 0, record_cid: "a" }, { seq: 1, record_cid: "b", anchor_tx: "0xtx" }]);
  });
  it("state blobs keep the current and the previous version only", async () => {
    const kv = createInMemoryKv(); const b = blobStore(kv);
    for (const v of [1, 2, 3, 4]) await b.put("card", v, { v });
    expect(await b.get("card", 4)).toEqual({ v: 4 });
    expect(await b.get("card", 3)).toEqual({ v: 3 });
    expect(await b.get("card", 2)).toBeNull();
    expect(await b.get("card", 1)).toBeNull();
  });
});
