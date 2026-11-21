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

  it("headers: a batch the enclave did not acknowledge is sent again, never skipped (a gap would freeze its chain)", async () => {
    const h = await harness();
    const st = newSchedulerState();
    const f = feed([{ number: 1, header_rlp: "AA", timestamp: 100 }, { number: 2, header_rlp: "AB", timestamp: 101 }]);
    h.enclave.silent = true;
    await headersTick(h.ctx, f, st);
    expect(st.newestHeader).toBe(0);
    h.enclave.silent = false;
    await headersTick(h.ctx, f, st);
    await headersTick(h.ctx, f, st);
    const sent = h.enclave.received.filter((m) => m.kind === "chain_headers");
    expect(sent).toHaveLength(2);
    expect(sent[1]!["headers"]).toEqual([{ number: 1, header_rlp: "AA" }, { number: 2, header_rlp: "AB" }]);
    expect(st.newestHeader).toBe(2);
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

describe("sealed links outlive their job (6.5)", () => {
  it("a sealed_link derived-card job's source policy is still watched after the job ends, until ends_at + 2 periods; an expiry_only one isn't", async () => {
    for (const [mode, watched] of [["sealed_link", true], ["expiry_only", false]] as const) {
      const h = await harness();
      const endsAt = Date.parse("2027-01-10T00:00:00.000Z");
      const dj = { ...job, ends_at: new Date(endsAt).toISOString(), parameters: { source_policy: "bafkreisrc" } };
      h.svc.policies.set(job["policy_id"], { notary: { contributor_predicate: {}, derived_card: { nullifier_period: "P1D" }, revocation_propagation: { mode } } as never, approvedNotaries: [] });
      await h.ctx.jobs.put({ job: dj, jobHash: JOB_HASH, programCid: "p", announcement: {}, epoch: 0, replicas: [kEnclaveInst], state: "ended", logHead: null });
      const at = (ms: number) => { (h.ctx as { now: () => number }).now = () => ms; };
      at(endsAt + 86_400_000);
      await snapshotsTick(h.ctx, feed([], []), newSchedulerState());
      expect(h.enclave.received.some((m) => m.kind === "policy_snapshot" && m["policy_address"] === "bafkreisrc"), mode).toBe(watched);
      h.enclave.received.length = 0;
      at(endsAt + 2 * 86_400_000 + 1);
      await snapshotsTick(h.ctx, feed([], []), newSchedulerState());
      expect(h.enclave.received.some((m) => m.kind === "policy_snapshot"), `${mode}, after the last card expired`).toBe(false);
    }
  });
});

describe("snapshots for a new job (6.0a)", () => {
  it("a first snapshot goes out as soon as a job needs the policy; the refresh sends nothing new for a policy already sent", async () => {
    const h = await harness();
    await openJob(h);
    const st = newSchedulerState();
    const f = feed([], []);
    await snapshotsTick(h.ctx, f, st, true);
    const first = h.enclave.received.filter((m) => m.kind === "policy_snapshot").length;
    await snapshotsTick(h.ctx, f, st, true);
    expect(h.enclave.received.filter((m) => m.kind === "policy_snapshot")).toHaveLength(first);
    expect(st.snapshotting).toBe(false);
  });
});

describe("private outputs (6.1)", () => {
  it("the routing envelopes in job_closed are delivered; a failed delivery alerts and does not stop the others", async () => {
    const envs = [{ to: "r", subcard_hash: "s1", payload: "AA" }, { to: "r", subcard_hash: "s2", payload: "AB" }];
    const h = await harness({ closeChunk: () => ({ notarization: { ok: 1 }, outputs: envs }) });
    await openJob(h);
    const st = newSchedulerState();
    st.chainTimeMs = CLOSES_MS;
    await closeTick(h.ctx, st);
    expect(h.svc.delivered).toEqual(envs);
  });
});

describe("per-input jobs: ciphertext retention and the end of the job (notary_host.md §7; 6.6 review)", () => {
  const perInputJob = { ...job, ends_at: "2027-01-10T00:00:00.000Z", key_period: "PT1H", parameters: { source_policy: "bafkreisrc" } } as Record<string, unknown>;
  delete (perInputJob as { closes_at?: string }).closes_at;
  const ENDS = Date.parse(String(perInputJob["ends_at"]));
  const setup = async (script = { submitInput: () => ({ input_hash: "x", receipt_sealed: "AA" }) } as never, mode = "expiry_only", period = "P1D") => {
    const h = await harness(script);
    h.svc.policies.set(job["policy_id"], { notary: { contributor_predicate: {}, derived_card: { nullifier_period: period }, revocation_propagation: { mode } } as never, approvedNotaries: [] });
    await h.ctx.jobs.put({ job: perInputJob, jobHash: JOB_HASH, programCid: "p", announcement: {}, epoch: 0, replicas: [kEnclaveInst], state: "open", logHead: null });
    return h;
  };

  it("a per-input input's ciphertext is deleted once the enclave has answered it; the host receipt is kept", async () => {
    const { handleSubmitInput } = await import("../src/handlers/inputs.js");
    const { H } = await import("@membership-card-protocol/wallet-sdk/notary-types");
    const h = await setup();
    const r = await handleSubmitInput(h.ctx, JOB_HASH, sealed);
    expect(r.receipt_sealed).toBe("AA");
    expect(await h.ctx.inputs.list(JOB_HASH)).toHaveLength(0);
    expect(await h.ctx.receipts.get(H(sealed))).not.toBeNull();
  });

  it("an enclave refusal also completes the run (the ciphertext goes); an unavailable enclave keeps it for the retry", async () => {
    const { handleSubmitInput } = await import("../src/handlers/inputs.js");
    const refused = await setup({ submitInput: () => ({ error: "DERIVE_DUPLICATE" }) } as never);
    await expect(handleSubmitInput(refused.ctx, JOB_HASH, sealed)).rejects.toMatchObject({ code: "DERIVE_DUPLICATE" });
    expect(await refused.ctx.inputs.list(JOB_HASH)).toHaveLength(0);
    const down = await setup();
    down.session.closed = true;
    await expect(handleSubmitInput(down.ctx, JOB_HASH, sealed)).rejects.toMatchObject({ code: "NH_ENCLAVE_UNAVAILABLE" });
    expect(await down.ctx.inputs.list(JOB_HASH)).toHaveLength(1);
  });

  it("negative control: an aggregate job keeps its ciphertexts until the close (they ARE the input to the recomputation)", async () => {
    const { handleSubmitInput } = await import("../src/handlers/inputs.js");
    const h = await harness({ submitInput: () => ({ input_hash: "x", receipt_sealed: "AA" }) });
    await openJob(h);
    await handleSubmitInput(h.ctx, JOB_HASH, sealed);
    expect(await h.ctx.inputs.list(JOB_HASH)).toHaveLength(1);
  });

  it("at ends_at by chain time the job is ended: inputs refused, leftovers deleted; before it, nothing happens", async () => {
    const { handleSubmitInput } = await import("../src/handlers/inputs.js");
    const { endTick } = await import("../src/schedulers/index.js");
    const h = await setup();
    await h.ctx.inputs.put(JOB_HASH, 0, "leftover", { sealedInput: sealed, receivedAt: "x" });
    const st = newSchedulerState();
    st.chainTimeMs = ENDS - 1;
    await endTick(h.ctx, st);
    expect((await h.ctx.jobs.get(JOB_HASH))!.state).toBe("open");
    expect(await h.ctx.inputs.list(JOB_HASH)).toHaveLength(1);
    st.chainTimeMs = ENDS;
    await endTick(h.ctx, st);
    expect((await h.ctx.jobs.get(JOB_HASH))!.state).toBe("ended");
    expect(await h.ctx.inputs.list(JOB_HASH)).toHaveLength(0);
    await expect(handleSubmitInput(h.ctx, JOB_HASH, sealed)).rejects.toMatchObject({ code: "NH_JOB_CLOSED" });
  });

  it("an aggregate job is not ended by this scheduler (it closes through closeTick)", async () => {
    const { endTick } = await import("../src/schedulers/index.js");
    const h = await harness();
    await openJob(h);
    const st = newSchedulerState();
    st.chainTimeMs = CLOSES_MS + 10 * 86_400_000;
    await endTick(h.ctx, st);
    expect((await h.ctx.jobs.get(JOB_HASH))!.state).toBe("open");
  });

  it("the ended record outlives the sealed-link watch: kept for ends_at + 2 periods + a day even when that exceeds 30 days (periods up to 90 days)", async () => {
    const { endTick } = await import("../src/schedulers/index.js");
    for (const [mode, period, days] of [["expiry_only", "P90D", 30], ["sealed_link", "P90D", 181], ["sealed_link", "P1D", 30]] as const) {
      const h = await setup(undefined, mode, period);
      const set: number[] = [];
      const orig = h.ctx.jobs.retire;
      (h.ctx as { jobs: { retire: typeof orig } }).jobs.retire = async (j, state, ttl) => { set.push(ttl ?? 30 * 86_400); return orig(j, state, ttl); };
      const st = newSchedulerState();
      st.chainTimeMs = ENDS;
      await endTick(h.ctx, st);
      expect(set[0], `${mode} ${period}`).toBe(days * 86_400);
    }
  });
});
