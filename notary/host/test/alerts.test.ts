/** The host's own monitoring checks (notary_host.md §13): each alert fires on its condition and stays quiet otherwise. */
import { describe, it, expect } from "vitest";
import { monitorTick, newSchedulerState } from "../src/schedulers/index.js";
import { harness, job, JOB_HASH, kEnclaveInst } from "./helpers.js";

const codes = (h: Awaited<ReturnType<typeof harness>>) => h.svc.alerts.map((a) => a.code);
const putJob = (h: Awaited<ReturnType<typeof harness>>, o: { replicas: string[]; state?: string; min_live?: number }) =>
  h.ctx.jobs.put({ job: { ...job, min_live: o.min_live ?? 1 }, jobHash: JOB_HASH, programCid: "p", announcement: {}, epoch: 0, replicas: o.replicas, state: (o.state ?? "open") as never, logHead: null });

describe("monitoring: the alerts the host raises itself", () => {
  it("quiet when everything is as configured", async () => {
    const h = await harness();
    await putJob(h, { replicas: [kEnclaveInst] });
    h.ctx.gas = { balanceWei: async () => 10n ** 18n };
    const st = newSchedulerState();
    st.lastSnapshotOkMs = h.ctx.now();
    await monitorTick(h.ctx, st, { snapshotSeconds: 30, gasLowWei: 10n ** 16n });
    expect(codes(h)).toEqual([]);
  });

  it("enclaves_attested: an enclave session that is down", async () => {
    const h = await harness();
    h.session.closed = true;
    await monitorTick(h.ctx, newSchedulerState(), { snapshotSeconds: 30 });
    expect(h.svc.alerts).toEqual([{ level: "warn", code: "enclaves_attested", counts: { attested: 0, configured: 1 } }]);
  });

  it("replicas_below_min_live: a live job with fewer live replicas than min_live; a finished job is not checked", async () => {
    const h = await harness();
    await putJob(h, { replicas: [kEnclaveInst], min_live: 2 });
    await monitorTick(h.ctx, newSchedulerState(), { snapshotSeconds: 30 });
    expect(h.svc.alerts).toEqual([{ level: "warn", code: "replicas_below_min_live", counts: { live: 1, min_live: 2 } }]);
    const done = await harness();
    await putJob(done, { replicas: [kEnclaveInst], min_live: 2, state: "finalized" });
    await monitorTick(done.ctx, newSchedulerState(), { snapshotSeconds: 30 });
    expect(codes(done)).toEqual([]);
  });

  it("gas_balance_low: below the threshold, and when the balance cannot be read; control: above it, quiet", async () => {
    const low = await harness();
    low.ctx.gas = { balanceWei: async () => 5_000_000_000n };
    await monitorTick(low.ctx, newSchedulerState(), { snapshotSeconds: 30, gasLowWei: 10n ** 16n });
    expect(low.svc.alerts).toEqual([{ level: "warn", code: "gas_balance_low", counts: { balance_gwei: 5 } }]);
    const broken = await harness();
    broken.ctx.gas = { balanceWei: async () => { throw new Error("rpc down"); } };
    await monitorTick(broken.ctx, newSchedulerState(), { snapshotSeconds: 30, gasLowWei: 10n ** 16n });
    expect(broken.svc.alerts).toEqual([{ level: "warn", code: "gas_balance_low", counts: { unreadable: 1 } }]);
    const ok = await harness();
    ok.ctx.gas = { balanceWei: async () => 10n ** 17n };
    await monitorTick(ok.ctx, newSchedulerState(), { snapshotSeconds: 30, gasLowWei: 10n ** 16n });
    expect(codes(ok)).toEqual([]);
  });

  it("snapshot_lag: no full snapshot pass for more than three refresh intervals; none yet is not a lag", async () => {
    const h = await harness();
    const st = newSchedulerState();
    await monitorTick(h.ctx, st, { snapshotSeconds: 30 }); // no pass has finished yet
    expect(codes(h)).toEqual([]);
    st.lastSnapshotOkMs = h.ctx.now();
    h.tick(100_000);
    await monitorTick(h.ctx, st, { snapshotSeconds: 30 });
    expect(h.svc.alerts).toEqual([{ level: "warn", code: "snapshot_lag", counts: { seconds: 100 } }]);
  });

  it("an alert is raised again only after five minutes", async () => {
    const h = await harness();
    h.session.closed = true;
    const st = newSchedulerState();
    await monitorTick(h.ctx, st, { snapshotSeconds: 30 });
    h.tick(60_000);
    await monitorTick(h.ctx, st, { snapshotSeconds: 30 });
    expect(codes(h)).toHaveLength(1);
    h.tick(5 * 60_000);
    await monitorTick(h.ctx, st, { snapshotSeconds: 30 });
    expect(codes(h)).toHaveLength(2);
  });
});
