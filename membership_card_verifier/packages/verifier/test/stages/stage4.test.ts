import { describe, it, expect, vi } from "vitest";
import { verifyStage4 } from "../../src/stages/stage4.js";
import type { RpcProvider, ChainLink, CardEntry, CardChainEvent } from "../../src/types.js";

/**
 * Builds a mock RpcProvider whose `getCardEntry`/`getCardEventLog` responses for
 * a given card address are driven by an explicit, ground-truth on-chain event
 * list. `headCid` defaults to the last event's cid (i.e. the on-chain head
 * matches the latest event) unless overridden, so tests can also construct a
 * head/event mismatch.
 */
function mockRpc(
  eventMap: Record<string, CardChainEvent[]>,
  headCidOverrides: Record<string, string> = {}
): RpcProvider {
  return {
    getCardEntry: vi.fn().mockImplementation((addr: string) => {
      const events = eventMap[addr] ?? [];
      const lastEvent = events[events.length - 1];
      const log_head_cid = headCidOverrides[addr] ?? lastEvent?.cid ?? "";
      const entry: CardEntry = {
        log_head_cid,
        policy_address: "0x",
        last_press_address: "0x",
        forward_to: null,
        exists: true,
      };
      return Promise.resolve(entry);
    }),
    isPolicyAuthorizer: vi.fn(),
    getPressAuthorization: vi.fn(),
    getSubCardEntry: vi.fn(),
    getCardEventLog: vi.fn().mockImplementation((addr: string) =>
      Promise.resolve(eventMap[addr] ?? [])
    ),
    getEasAnnotations: vi.fn().mockResolvedValue([]),
  };
}

function chainLink(card_address: string, card_content: Record<string, unknown>): ChainLink {
  return { card_address, public_key: "", card_content };
}

const SIGNING_TIME = "2026-06-01T00:00:00Z";
const BASE_CONFIG = { revocationFreshnessWindowSeconds: 300, rejectStaleRevocation: true };

describe("stage4 — revocation check", () => {
  it("genesis card, no on-chain events → not_revoked, was/is valid", async () => {
    const rpc = mockRpc({ "0xcard1": [] }, { "0xcard1": "QmGenesis" });
    const chain = [chainLink("0xcard1", { policy_id: "QmPolicy" })];
    const result = await verifyStage4(chain, SIGNING_TIME, rpc, BASE_CONFIG);
    expect(result.revocation.status).toBe("not_revoked");
    expect(result.was_valid_at_signing_time).toBe(true);
    expect(result.is_currently_valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("8xx revocation after signing time → was_valid=true, is_currently_valid=false", async () => {
    const rpc = mockRpc({
      "0xcard1": [
        { cid: "QmGenesis", timestamp: "2026-05-01T00:00:00Z" },
        { cid: "QmRevoke", timestamp: "2026-06-15T00:00:00Z" },
      ],
    });
    const chain = [
      chainLink("0xcard1", {
        entry_type: "revocation",
        code: 810,
        history: ["QmGenesis"],
        revocation: { effective_date: "2026-06-15T00:00:00Z" },
      }),
    ];
    const result = await verifyStage4(chain, SIGNING_TIME, rpc, BASE_CONFIG);
    expect(result.revocation.status).toBe("revoked");
    expect(result.revocation.effective_date).toBe("2026-06-15T00:00:00Z");
    expect(result.was_valid_at_signing_time).toBe(true);
    expect(result.is_currently_valid).toBe(false);
    expect(result.errors).toHaveLength(0);
  });

  it("8xx revocation before signing time → was_valid=false", async () => {
    const rpc = mockRpc({
      "0xcard1": [
        { cid: "QmGenesis", timestamp: "2026-04-01T00:00:00Z" },
        { cid: "QmRevoke", timestamp: "2026-05-01T00:00:00Z" },
      ],
    });
    const chain = [
      chainLink("0xcard1", {
        entry_type: "revocation",
        code: 810,
        history: ["QmGenesis"],
        revocation: { effective_date: "2026-05-01T00:00:00Z" },
      }),
    ];
    const result = await verifyStage4(chain, SIGNING_TIME, rpc, BASE_CONFIG);
    expect(result.was_valid_at_signing_time).toBe(false);
  });

  it("9xx revocation produces loud_revocation status", async () => {
    const rpc = mockRpc({
      "0xcard1": [
        { cid: "QmGenesis", timestamp: "2026-05-01T00:00:00Z" },
        { cid: "QmRevoke", timestamp: "2026-06-15T00:00:00Z" },
      ],
    });
    const chain = [
      chainLink("0xcard1", {
        entry_type: "revocation",
        code: 900,
        history: ["QmGenesis"],
        revocation: { effective_date: "2026-06-15T00:00:00Z" },
      }),
    ];
    const result = await verifyStage4(chain, SIGNING_TIME, rpc, BASE_CONFIG);
    expect(result.revocation.status).toBe("loud_revocation");
  });

  it("multiple chain links, one revoked: earliest revocation across the chain governs", async () => {
    const rpc = mockRpc({
      "0xcard1": [
        { cid: "QmGenesis1", timestamp: "2026-05-01T00:00:00Z" },
        { cid: "QmRevoke1", timestamp: "2026-06-20T00:00:00Z" },
      ],
      "0xcard2": [
        { cid: "QmGenesis2", timestamp: "2026-05-01T00:00:00Z" },
        { cid: "QmRevoke2", timestamp: "2026-06-10T00:00:00Z" },
      ],
    });
    const chain = [
      chainLink("0xcard1", {
        entry_type: "revocation",
        code: 810,
        history: ["QmGenesis1"],
        revocation: { effective_date: "2026-06-20T00:00:00Z" },
      }),
      chainLink("0xcard2", {
        entry_type: "revocation",
        code: 810,
        history: ["QmGenesis2"],
        revocation: { effective_date: "2026-06-10T00:00:00Z" },
      }),
    ];
    const result = await verifyStage4(chain, SIGNING_TIME, rpc, BASE_CONFIG);
    expect(result.revocation.effective_date).toBe("2026-06-10T00:00:00Z");
  });

  it("non-revocation log entries (1xx-7xx) appear in log_updates, dated by the on-chain event timestamp", async () => {
    const rpc = mockRpc({
      "0xcard1": [
        { cid: "QmGenesis", timestamp: "2026-05-01T00:00:00Z" },
        { cid: "QmUpdate", timestamp: "2026-06-01T00:00:00Z" },
      ],
    });
    const chain = [
      chainLink("0xcard1", {
        entry_type: "field_update",
        code: 100,
        history: ["QmGenesis"],
      }),
    ];
    const result = await verifyStage4(chain, SIGNING_TIME, rpc, BASE_CONFIG);
    expect(result.log_updates).toHaveLength(1);
    expect(result.log_updates[0]?.update_code).toBe(100);
    expect(result.log_updates[0]?.cid).toBe("QmUpdate");
    expect(result.log_updates[0]?.effective_date).toBe("2026-06-01T00:00:00Z");
  });

  it("HISTORY_MISMATCH: self-reported history disagrees with the on-chain event replay", async () => {
    // On-chain ground truth has two prior entries before the head...
    const rpc = mockRpc({
      "0xcard1": [
        { cid: "QmGenesis", timestamp: "2026-05-01T00:00:00Z" },
        { cid: "QmMiddle", timestamp: "2026-05-15T00:00:00Z" },
        { cid: "QmUpdate", timestamp: "2026-06-01T00:00:00Z" },
      ],
    });
    // ...but the IPFS head content only claims one predecessor, omitting QmMiddle.
    const chain = [
      chainLink("0xcard1", {
        entry_type: "field_update",
        code: 100,
        history: ["QmGenesis"],
      }),
    ];
    const result = await verifyStage4(chain, SIGNING_TIME, rpc, BASE_CONFIG);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ stage: 4, code: "HISTORY_MISMATCH" })
    );
  });

  it("no HISTORY_MISMATCH when self-reported history matches the on-chain event replay exactly", async () => {
    const rpc = mockRpc({
      "0xcard1": [
        { cid: "QmGenesis", timestamp: "2026-05-01T00:00:00Z" },
        { cid: "QmMiddle", timestamp: "2026-05-15T00:00:00Z" },
        { cid: "QmUpdate", timestamp: "2026-06-01T00:00:00Z" },
      ],
    });
    const chain = [
      chainLink("0xcard1", {
        entry_type: "field_update",
        code: 100,
        history: ["QmGenesis", "QmMiddle"],
      }),
    ];
    const result = await verifyStage4(chain, SIGNING_TIME, rpc, BASE_CONFIG);
    expect(result.errors.find((e) => e.code === "HISTORY_MISMATCH")).toBeUndefined();
  });

  describe("step 5a — expires_at (card_verifier.md §7.4, protocol-objects.md §1)", () => {
    const rpcFor = () => mockRpc({ "0xcard1": [] }, { "0xcard1": "QmGenesis" });

    it("a card past its expires_at: not currently valid, but valid for things signed before it; reason is expired", async () => {
      const chain = [chainLink("0xcard1", { policy_id: "QmP", expires_at: "2026-07-01T00:00:00Z" })];
      const r = await verifyStage4(chain, SIGNING_TIME, rpcFor(), BASE_CONFIG);
      expect(r.revocation).toMatchObject({ status: "revoked", code: null, reason: "expired", effective_date: "2026-07-01T00:00:00.000Z" });
      expect(r.was_valid_at_signing_time).toBe(true); // signed 2026-06-01, before the lapse
      expect(r.is_currently_valid).toBe(false);        // the verifier's clock is past 2026-07-01
    });

    it("things signed on or after expires_at are not trusted", async () => {
      const chain = [chainLink("0xcard1", { policy_id: "QmP", expires_at: "2026-05-01T00:00:00Z" })];
      const r = await verifyStage4(chain, SIGNING_TIME, rpcFor(), BASE_CONFIG);
      expect(r.was_valid_at_signing_time).toBe(false);
    });

    it("an expiry in the future leaves the card valid and not revoked", async () => {
      const chain = [chainLink("0xcard1", { policy_id: "QmP", expires_at: "2999-01-01T00:00:00Z" })];
      const r = await verifyStage4(chain, SIGNING_TIME, rpcFor(), BASE_CONFIG);
      expect(r.revocation.status).toBe("not_revoked");
      expect(r.revocation.reason).toBeUndefined();
      expect(r.is_currently_valid).toBe(true);
    });

    it("an ancestor's expiry governs the whole chain", async () => {
      const chain = [chainLink("0xcard1", { policy_id: "QmP" }), chainLink("0xparent", { policy_id: "QmQ", expires_at: "2026-07-01T00:00:00Z" })];
      const rpc = mockRpc({ "0xcard1": [], "0xparent": [] }, { "0xcard1": "A", "0xparent": "B" });
      const r = await verifyStage4(chain, SIGNING_TIME, rpc, BASE_CONFIG);
      expect(r.revocation.reason).toBe("expired");
      expect(r.is_currently_valid).toBe(false);
    });

    it("when an 8xx revocation is also present, the earlier date governs", async () => {
      const events = { "0xcard1": [{ cid: "QmGenesis", timestamp: "2026-01-01T00:00:00Z" }, { cid: "QmRev", timestamp: "2026-06-15T00:00:00Z" }] };
      const chain = [chainLink("0xcard1", { entry_type: "revocation", code: 800, history: ["QmGenesis"], revocation: { effective_date: "2026-06-15T00:00:00Z" }, expires_at: "2026-09-01T00:00:00Z" })];
      const r = await verifyStage4(chain, SIGNING_TIME, mockRpc(events), BASE_CONFIG);
      expect(r.revocation).toMatchObject({ status: "revoked", code: 800 });
      expect(r.revocation.reason).toBeUndefined();
      // and the other way round: expiry earlier than the revocation
      const chain2 = [chainLink("0xcard1", { entry_type: "revocation", code: 800, history: ["QmGenesis"], revocation: { effective_date: "2026-06-15T00:00:00Z" }, expires_at: "2026-06-10T00:00:00Z" })];
      const r2 = await verifyStage4(chain2, SIGNING_TIME, mockRpc(events), BASE_CONFIG);
      expect(r2.revocation).toMatchObject({ status: "revoked", reason: "expired", effective_date: "2026-06-10T00:00:00.000Z" });
    });

    it("an unparsable expires_at is ignored, not fatal", async () => {
      const chain = [chainLink("0xcard1", { policy_id: "QmP", expires_at: "tomorrow" })];
      const r = await verifyStage4(chain, SIGNING_TIME, rpcFor(), BASE_CONFIG);
      expect(r.revocation.status).toBe("not_revoked");
    });
  });
});
