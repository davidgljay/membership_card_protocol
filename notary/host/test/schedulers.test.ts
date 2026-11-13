import { describe, it, expect } from "vitest";
import { canonicalNotary, cidOfBytes } from "@membership-card-protocol/wallet-sdk/notary-types";
import { closeTick, headersTick, newSchedulerState, relevantPolicies, snapshotsTick } from "../src/schedulers/index.js";
import type { ChainFeed } from "../src/services.js";
import type { RegistryEvent } from "../src/chain/snapshots.js";
import { harness, job, JOB_HASH, kEnclaveInst, sealed, flush } from "./helpers.js";

const CLOSES_MS = Date.parse(String(job["closes_at"] ?? job["ends_at"]));
const feed = (headers: { number: number; header_rlp: string; timestamp: number }[], events: RegistryEvent[] = []): ChainFeed => ({
  headersAfter: async (n) => headers.filter((h) => h.number > n),
  registry: async (policy) => ({ events: events.filter((e) => e.policyAddress === policy), subcards: [], block: 9 }),
});
const openJob = async (h: Awaited<ReturnType<typeof harness>>) => h.ctx.jobs.put({ job, jobHash: JOB_HASH, programCid: "p", announcement: {}, epoch: 0, replicas: [kEnclaveInst], state: "open", logHead: null });

describe("schedulers (notary_host.md §8; replication §5)", () => {
  it("relevant policies: issued_under_template values (literal or parameter), and a derived-card job's source_policy", () => {
    const n = { contributor_predicate: { all_of: [{ issued_under_template: "bafkreia" }, { any_of: [{ issued_under_template: { param: "p" } }] }] } };
    expect(relevantPolicies({ parameters: { p: "bafkreib" } }, n)).toEqual(["bafkreia", "bafkreib"]);
    expect(relevantPolicies({ parameters: { source_policy: "bafkreis" } }, { contributor_predicate: {}, derived_card: {} })).toEqual(["bafkreis"]);
    expect(relevantPolicies({ parameters: { source_policy: "bafkreis" } }, { contributor_predicate: {} })).toEqual([]);
  });

  it("headers: new headers reach every live enclave once, oldest first; chain time follows the newest", async () => {
    const h = await harness();
    const st = newSchedulerState();
    const f = feed([{ number: 1, header_rlp: "AA", timestamp: 100 }, { number: 2, header_rlp: "AB", timestamp: 101 }]);
    await headersTick(h.ctx, f, st);
    await headersTick(h.ctx, f, st);
    const sent = h.enclave.received.filter((m) => m.kind === "chain_headers");
    expect(sent).toHaveLength(1);
    expect(sent[0]!["headers"]).toEqual([{ number: 1, header_rlp: "AA" }, { number: 2, header_rlp: "AB" }]);
    expect(st.chainTimeMs).toBe(101_000);
  });

  it("snapshots: a whole-policy snapshot first, then unfiltered updates, for each policy a live job depends on", async () => {
    const h = await harness();
    h.svc.policies.set(job["policy_id"], { notary: { contributor_predicate: { issued_under_template: "bafkreisrc" } } as never, approvedNotaries: [] });
    await openJob(h);
    const ev = (card: string, block: number): RegistryEvent => ({ kind: "CardRegistered", policyAddress: "bafkreisrc", cardAddress: card, headCid: "h", pressAddress: "p", block, timestamp: "2027-01-01T00:00:00.000Z" });
    const st = newSchedulerState();
    await snapshotsTick(h.ctx, feed([], [ev("c1", 3)]), st);
    const snap = h.enclave.received.find((m) => m.kind === "policy_snapshot")!;
    expect(snap["policy_address"]).toBe("bafkreisrc");
    expect((snap["entries"] as { address: string }[]).map((e) => e.address)).toEqual(["c1"]);
    st.sentPolicies.set("bafkreisrc", 3);
    await snapshotsTick(h.ctx, feed([], [ev("c1", 3), ev("c2", 5)]), st);
    await flush();
    const upd = h.enclave.received.find((m) => m.kind === "policy_updates")!;
    expect((upd["updates"] as { card_address: string }[]).map((u) => u.card_address)).toEqual(["c2"]);
  });

  it("close: nothing before closes_at on the chain; after it, every stored ciphertext in close_chunk, and the notarization is pinned", async () => {
    const h = await harness();
    await openJob(h);
    await h.ctx.inputs.put(JOB_HASH, 0, "ih1", { sealedInput: sealed, receivedAt: "t" });
    const st = newSchedulerState();
    st.chainTimeMs = CLOSES_MS - 1;
    await closeTick(h.ctx, st);
    expect(h.enclave.received.some((m) => m.kind === "close_chunk")).toBe(false);
    st.chainTimeMs = CLOSES_MS;
    await closeTick(h.ctx, st);
    const c = h.enclave.received.filter((m) => m.kind === "close_chunk");
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ job_hash: JOB_HASH, seq: 0, last: true, sealed_inputs: [sealed] });
    const n = canonicalNotary({ type: "notary.notarization.v1", mock: true });
    expect(await h.ctx.ipfs.fetch(cidOfBytes(n))).toEqual(n);
  });

  it("close: CLOSE_NOT_DUE (the enclave's attested clock isn't there yet) is retried quietly on a later tick", async () => {
    let due = false;
    const h = await harness({ closeChunk: () => (due ? { notarization: { ok: 1 } } : { error: "CLOSE_NOT_DUE" }) });
    await openJob(h);
    const st = newSchedulerState();
    st.chainTimeMs = CLOSES_MS;
    await closeTick(h.ctx, st);
    expect(h.svc.alerts).toEqual([]);
    due = true;
    await closeTick(h.ctx, st);
    expect(h.enclave.received.filter((m) => m.kind === "close_chunk")).toHaveLength(2);
  });
});
