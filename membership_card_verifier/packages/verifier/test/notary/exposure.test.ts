import { describe, it, expect } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { b64uEncode, canonicalNotary, cardPointer, cidOfBytes, exposureTime, judgeItem, keyLineage, makeKeyExposureRead } from "../../src/notary/index.js";
import type { AcceptedRuntime, ExposureReads } from "../../src/notary/index.js";

const te = new TextEncoder();
const key = (n: number) => ml_dsa44.keygen(sha256(te.encode(`exposure-key-${n}`)));
const pub = (n: number) => b64uEncode(key(n).publicKey);
const sign = (n: number, u: object) => ({ public_key: pub(n), signature: b64uEncode(ml_dsa44.sign(canonicalNotary(u), key(n).secretKey, { extraEntropy: false })) });
const CARD = cardPointer(key(1).publicKey);
const pcr = (n: number) => new Uint8Array(48).fill(n);
const T = (s: string) => Date.parse(s);

const store = new Map<string, Uint8Array>();
function record(seq: number, body: object, prev: string | undefined, o: { kind?: string; signer?: number; instSigner?: number; job?: string } = {}) {
  const u: Record<string, unknown> = { at: "2026-10-01T00:00:00Z", body, instance: b64uEncode(sha256(key(7).publicKey)), job_hash: o.job ?? CARD, kind: o.kind ?? "handoff", seq, type: "notary.identity_log.v1", ...(prev ? { prev } : {}) };
  const rec = { ...u, notary_signature: sign(o.signer ?? 1, u), instance_signature: sign(o.instSigner ?? 7, u) };
  const bytes = canonicalNotary(rec);
  const cid = cidOfBytes(bytes);
  store.set(cid, bytes);
  return cid;
}
const handoff = (to: number, scope = "identity") => ({ scope, pcr0_to: b64uEncode(pcr(to)) });

const runtime = (n: number, extra: Partial<AcceptedRuntime> = {}): AcceptedRuntime => ({
  accepted_from: "2026-01-01T00:00:00Z", build_recipe_cid: "c", close_compat: "k", pcr0: b64uEncode(pcr(n)), platform: "aws-nitro-enclaves", source_commit: "s", version: "1", ...extra });
const vuln = (n: number, at: string) => runtime(n, { retire_reason: "vulnerable", retired_at: at });

function reads(anchors: { seq: number; record_cid: string }[]): ExposureReads {
  return { anchors: async () => anchors.map((a) => ({ ...a, timestamp: 0 })), fetch: async (c) => store.get(c) ?? null };
}
const lineage = (anchors: { seq: number; record_cid: string }[]) => keyLineage({ card: CARD, kIdPubkey: pub(1), genesisPcr0: pcr(1), reads: reads(anchors) });

describe("algorithm E (notary_lifecycle.md A.6)", () => {
  const r0 = record(0, handoff(2), undefined);
  const r1 = record(1, handoff(3), r0);
  const good = [{ seq: 0, record_cid: r0 }, { seq: 1, record_cid: r1 }];

  it("lineage = genesis PCR0 plus pcr0_to of every identity-scope handoff; a card with no handoff has only the genesis runtime", async () => {
    const l = await lineage(good);
    expect(l.ok && [...l.pcr0s].sort()).toEqual([1, 2, 3].map((n) => b64uEncode(pcr(n))).sort());
    const none = await lineage([]);
    expect(none.ok && [...none.pcr0s]).toEqual([b64uEncode(pcr(1))]);
  });
  it("only identity-scope handoffs add to the lineage", async () => {
    const a = record(0, handoff(9, "job"), undefined);
    const l = await lineage([{ seq: 0, record_cid: a }]);
    expect(l.ok && l.pcr0s.has(b64uEncode(pcr(9)))).toBe(false);
  });

  describe("NOTARY_LINEAGE_INCOMPLETE", () => {
    const code = async (a: { seq: number; record_cid: string }[]) => { const l = await lineage(a); return l.ok ? "ok" : l.code; };
    it("a gap in seq", async () => expect(await code([{ seq: 0, record_cid: r0 }, { seq: 2, record_cid: r1 }])).toBe("NOTARY_LINEAGE_INCOMPLETE"));
    it("a log that starts above seq 0", async () => expect(await code([{ seq: 1, record_cid: r1 }])).toBe("NOTARY_LINEAGE_INCOMPLETE"));
    it("a fork: two different records anchored for one seq", async () => {
      const other = record(0, handoff(8), undefined);
      expect(await code([{ seq: 0, record_cid: r0 }, { seq: 0, record_cid: other }])).toBe("NOTARY_LINEAGE_INCOMPLETE");
    });
    it("the same record anchored twice is not a fork", async () => expect(await code([{ seq: 0, record_cid: r0 }, { seq: 0, record_cid: r0 }])).toBe("ok"));
    it("a broken prev link", async () => {
      const bad = record(1, handoff(3), "bafkreiwrong");
      expect(await code([{ seq: 0, record_cid: r0 }, { seq: 1, record_cid: bad }])).toBe("NOTARY_LINEAGE_INCOMPLETE");
    });
    it("a record signed by someone other than K_id, or with a bad instance signature", async () => {
      expect(await code([{ seq: 0, record_cid: record(0, handoff(2), undefined, { signer: 9 }) }])).toBe("NOTARY_LINEAGE_INCOMPLETE");
      expect(await code([{ seq: 0, record_cid: record(0, handoff(2), undefined, { instSigner: 9 }) }])).toBe("NOTARY_LINEAGE_INCOMPLETE");
    });
    it("a record for another card, or unavailable, or not matching its CID", async () => {
      expect(await code([{ seq: 0, record_cid: record(0, handoff(2), undefined, { job: cardPointer(key(5).publicKey) }) }])).toBe("NOTARY_LINEAGE_INCOMPLETE");
      expect(await code([{ seq: 0, record_cid: "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }])).toBe("NOTARY_LINEAGE_INCOMPLETE");
      const swapped = { anchors: async () => [{ seq: 0, record_cid: r0, timestamp: 0 }], fetch: async () => store.get(r1)! };
      const l = await keyLineage({ card: CARD, kIdPubkey: pub(1), genesisPcr0: pcr(1), reads: swapped });
      expect(l.ok).toBe(false);
    });
    it("a malformed pcr0_to", async () => expect(await code([{ seq: 0, record_cid: record(0, { scope: "identity", pcr0_to: "AAAA" }, undefined) }])).toBe("NOTARY_LINEAGE_INCOMPLETE"));
  });

  describe("exposure time and judgement", () => {
    const l = new Set([1, 2, 3].map((n) => b64uEncode(pcr(n))));
    it("none when no lineage runtime is retired as vulnerable (superseded does not count)", () => {
      expect(exposureTime(l, [runtime(1), runtime(2, { retire_reason: "superseded", retired_at: "2026-02-01T00:00:00Z" }), vuln(9, "2026-02-01T00:00:00Z")])).toBeUndefined();
    });
    it("the earliest vulnerable retirement among lineage runtimes", () => {
      expect(exposureTime(l, [vuln(3, "2026-05-01T00:00:00Z"), vuln(2, "2026-03-01T00:00:00Z"), vuln(9, "2026-01-01T00:00:00Z")])).toBe(T("2026-03-01T00:00:00Z"));
    });
    it("an item at or after t_x is rejected; before it, a warning; with no exposure, none", () => {
      const tx = T("2026-03-01T00:00:00Z");
      expect(judgeItem(tx, tx)).toBe("exposed");
      expect(judgeItem(tx, tx + 1)).toBe("exposed");
      expect(judgeItem(tx, tx - 1)).toBe("later");
      expect(judgeItem(undefined, tx)).toBe("none");
    });
  });

  it("makeKeyExposureRead ties the steps together; an unknown card or a broken log is lineage_incomplete", async () => {
    const accepted = [vuln(2, "2026-03-01T00:00:00Z")];
    const read = makeKeyExposureRead({ reads: reads(good), accepted, card: async (p) => (p === CARD ? { kIdPubkey: pub(1), genesisPcr0: pcr(1) } : null) });
    expect(await read(CARD, T("2026-04-01T00:00:00Z"))).toBe("exposed");
    expect(await read(CARD, T("2026-02-01T00:00:00Z"))).toBe("later");
    expect(await read("unknown", 0)).toBe("lineage_incomplete");
    const broken = makeKeyExposureRead({ reads: reads([{ seq: 1, record_cid: r1 }]), accepted, card: async () => ({ kIdPubkey: pub(1), genesisPcr0: pcr(1) }) });
    expect(await broken(CARD, 0)).toBe("lineage_incomplete");
    const clean = makeKeyExposureRead({ reads: reads(good), accepted: [runtime(2)], card: async () => ({ kIdPubkey: pub(1), genesisPcr0: pcr(1) }) });
    expect(await clean(CARD, T("2030-01-01T00:00:00Z"))).toBe("none");
  });
});
