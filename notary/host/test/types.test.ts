import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNotaryObject, canonicalNotary, H } from "@membership-card-protocol/wallet-sdk/notary-types";
import { b64uEncode } from "@membership-card-protocol/verifier/notary";
import type { HandoffRecord, Heartbeat, StateBlobHeader, PropagationBatch } from "../src/types.ts";
import { ANCHORED_KINDS } from "../src/types.ts";

const V = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "vectors", "objects");
const first = <T>(n: string) => JSON.parse(readFileSync(join(V, `${n}.json`), "utf8")).cases[0] as { input: T; canonical_b64u: string; h: string; type: string };

describe("host/enclave-only objects (§29–§32) against shared vectors", () => {
  it.each(["handoff", "heartbeat", "state_blob", "propagation_batch", "job_log", "identity_log"])("%s is strict and canonical", (n) => {
    const c = first<Record<string, unknown>>(n);
    assertNotaryObject(c.input, c.type);
    expect(b64uEncode(canonicalNotary(c.input))).toBe(c.canonical_b64u);
    expect(H(c.input)).toBe(c.h);
  });
  it("satisfy the interfaces; job-log kinds are anchored per §28", () => {
    const h: HandoffRecord = first<HandoffRecord>("handoff").input;
    const b: Heartbeat = first<Heartbeat>("heartbeat").input;
    const s: StateBlobHeader = first<StateBlobHeader>("state_blob").input;
    const p: PropagationBatch = first<PropagationBatch>("propagation_batch").input;
    expect([h.scope, b.seq, s.version, p.batch_seq]).toEqual(["job", 99, 4, 2]);
    expect(ANCHORED_KINDS).toContain("notarized");
    expect(ANCHORED_KINDS).not.toContain("replicated");
    expect(ANCHORED_KINDS).not.toContain("closed");
  });
});
