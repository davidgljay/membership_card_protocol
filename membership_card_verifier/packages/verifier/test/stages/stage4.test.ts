import { describe, it, expect, vi } from "vitest";
import { verifyStage4 } from "../../src/stages/stage4.js";
import type { RpcProvider, LogEntry } from "../../src/types.js";

function mockRpc(logMap: Record<string, LogEntry[]>): RpcProvider {
  return {
    getCardEntry: vi.fn(),
    isPolicyAuthorizer: vi.fn(),
    getPressAuthorization: vi.fn(),
    getSubCardEntry: vi.fn(),
    getLogEntries: vi.fn().mockImplementation((addr: string) =>
      Promise.resolve(logMap[addr] ?? [])
    ),
    getEasAnnotations: vi.fn().mockResolvedValue([]),
  };
}

const SIGNING_TIME = "2026-06-01T00:00:00Z";
const CHAIN = ["0xcard1"];
const BASE_CONFIG = { revocationFreshnessWindowSeconds: 300, rejectStaleRevocation: true };

describe("stage4 — revocation check", () => {
  it("no revocation entries → not_revoked, was/is valid", async () => {
    const rpc = mockRpc({ "0xcard1": [] });
    const result = await verifyStage4(CHAIN, SIGNING_TIME, rpc, BASE_CONFIG);
    expect(result.revocation.status).toBe("not_revoked");
    expect(result.was_valid_at_signing_time).toBe(true);
    expect(result.is_currently_valid).toBe(true);
  });

  it("8xx revocation after signing time → was_valid=true, is_currently_valid=false", async () => {
    const rpc = mockRpc({
      "0xcard1": [{ update_code: 810, effective_date: "2026-06-15T00:00:00Z", cid: "Qm1" }],
    });
    const result = await verifyStage4(CHAIN, SIGNING_TIME, rpc, BASE_CONFIG);
    expect(result.revocation.status).toBe("revoked");
    expect(result.was_valid_at_signing_time).toBe(true);
    expect(result.is_currently_valid).toBe(false);
  });

  it("8xx revocation before signing time → was_valid=false", async () => {
    const rpc = mockRpc({
      "0xcard1": [{ update_code: 810, effective_date: "2026-05-01T00:00:00Z", cid: "Qm1" }],
    });
    const result = await verifyStage4(CHAIN, SIGNING_TIME, rpc, BASE_CONFIG);
    expect(result.was_valid_at_signing_time).toBe(false);
  });

  it("9xx revocation produces loud_revocation status", async () => {
    const rpc = mockRpc({
      "0xcard1": [{ update_code: 900, effective_date: "2026-06-15T00:00:00Z", cid: "Qm1" }],
    });
    const result = await verifyStage4(CHAIN, SIGNING_TIME, rpc, BASE_CONFIG);
    expect(result.revocation.status).toBe("loud_revocation");
  });

  it("multiple revocation entries: earliest governs", async () => {
    const rpc = mockRpc({
      "0xcard1": [
        { update_code: 810, effective_date: "2026-06-20T00:00:00Z", cid: "Qm2" },
        { update_code: 810, effective_date: "2026-06-10T00:00:00Z", cid: "Qm1" },
      ],
    });
    const result = await verifyStage4(CHAIN, SIGNING_TIME, rpc, BASE_CONFIG);
    expect(result.revocation.effective_date).toBe("2026-06-10T00:00:00Z");
  });

  it("non-revocation log entries (1xx–7xx) appear in log_updates", async () => {
    const rpc = mockRpc({
      "0xcard1": [
        { update_code: 100, effective_date: "2026-06-01T00:00:00Z", cid: "QmUpdate" },
      ],
    });
    const result = await verifyStage4(CHAIN, SIGNING_TIME, rpc, BASE_CONFIG);
    expect(result.log_updates).toHaveLength(1);
    expect(result.log_updates[0]?.update_code).toBe(100);
  });
});
