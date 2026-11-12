import { describe, it, expect } from "vitest";
import { p256 } from "@noble/curves/p256";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { sha256 } from "@noble/hashes/sha256";
import { approvalDigest, b64uEncode, canonicalNotary, H, isRemovalOnly, verifyListApproval, verifyMemberSignature } from "../../src/notary/index.js";
import type { GovernanceKeyset, ListVersion } from "../../src/notary/index.js";

const te = new TextEncoder();
const CARD = "ab".repeat(32);
const sk0 = (i: number) => sha256(te.encode(`gov-p256-${i}`));
const pk0 = (i: number) => p256.getPublicKey(sk0(i), false).slice(1);
const ks0: GovernanceKeyset = { keys: [0, 1, 2, 3, 4].map(pk0), quorum: 4, version: 3, key_scheme: 0 };
const sig0 = (i: number, digest: Uint8Array) => b64uEncode(p256.sign(digest, sk0(i), { lowS: false }).toCompactRawBytes());
const mlk = (i: number) => ml_dsa44.keygen(sha256(te.encode(`gov-mldsa-${i}`)));
const ks1: GovernanceKeyset = { keys: [0, 1, 2].map((i) => mlk(i).publicKey), quorum: 2, version: 3, key_scheme: 1 };
const sig1 = (i: number, digest: Uint8Array) => b64uEncode(ml_dsa44.sign(digest, mlk(i).secretKey, { extraEntropy: false }));

const rt = (pcr: string, extra: object = {}) => ({ accepted_from: "2026-01-01T00:00:00Z", build_recipe_cid: "c", close_compat: "k1", pcr0: pcr, platform: "aws-nitro-enclaves", source_commit: "s", version: "1", ...extra });

function version(value: unknown[], v: number, prev: ListVersion | undefined, o: { kind?: "standard" | "emergency_retirement"; signers?: number[]; gov?: number; ks?: GovernanceKeyset; mut?: (a: Record<string, unknown>) => void } = {}): ListVersion {
  const ks = o.ks ?? ks0;
  const approval: Record<string, unknown> = {
    governance_version: o.gov ?? ks.version, kind: o.kind ?? "standard", list: "accepted_runtimes", list_card: CARD, list_hash: H(value), list_version: v,
    ...(prev ? { prev_list_hash: H(prev.value) } : {}), type: "notary_list_approval",
  };
  o.mut?.(approval);
  const digest = approvalDigest(approval);
  const sign = ks.key_scheme === 0 ? sig0 : sig1;
  const signatures = (o.signers ?? [0, 1, 2, 3]).map((i) => ({ key_index: i, signature: sign(i, digest) }));
  return { value, approvalText: new TextDecoder().decode(canonicalNotary({ ...approval, signatures })) };
}
const check = (history: ListVersion[], ks = ks0) => verifyListApproval({ list: "accepted_runtimes", listCard: CARD, history, keyset: ks });
const code = (r: ReturnType<typeof check>) => (r.ok ? "ok" : r.code);

const L1 = [rt("AA")];
const L2 = [rt("AA"), rt("BB")];
const v1 = version(L1, 1, undefined);
const v2 = version(L2, 2, v1);

describe("algorithm L (notary_lifecycle.md A.5)", () => {
  it("accepts standard versions with quorum, ECDSA and ML-DSA keysets", () => {
    expect(check([v1])).toMatchObject({ ok: true, listVersion: 1 });
    expect(check([v1, v2])).toMatchObject({ ok: true, listVersion: 2, list: L2 });
    const m1 = version(L1, 1, undefined, { ks: ks1, signers: [0, 1] });
    expect(check([m1], ks1).ok).toBe(true);
    expect(code(check([version(L1, 1, undefined, { ks: ks1, signers: [0] })], ks1))).toBe("LIST_APPROVAL_THRESHOLD");
  });
  it("member signs the 32 raw digest bytes (E6): a signature over the base64url text does not count", () => {
    const approval = { governance_version: 3, kind: "standard", list: "accepted_runtimes", list_card: CARD, list_hash: H(L1), list_version: 1, type: "notary_list_approval" };
    const digest = approvalDigest(approval);
    const overText = b64uEncode(p256.sign(sha256(te.encode(b64uEncode(digest))), sk0(0), { lowS: false }).toCompactRawBytes());
    expect(verifyMemberSignature(0, ks0.keys[0]!, digest, b64uDecodeLoose(sig0(0, digest)))).toBe(true);
    expect(verifyMemberSignature(0, ks0.keys[0]!, digest, b64uDecodeLoose(overText))).toBe(false);
  });
  it("LIST_APPROVAL_MISSING / MALFORMED", () => {
    expect(code(check([{ value: L1, approvalText: undefined }]))).toBe("LIST_APPROVAL_MISSING");
    expect(code(check([{ value: L1, approvalText: "{ not canonical }" }]))).toBe("LIST_APPROVAL_MALFORMED");
    expect(code(check([version(L1, 1, undefined, { mut: (a) => { a["list"] = "program_allowlist"; } })]))).toBe("LIST_APPROVAL_MALFORMED");
    expect(code(check([version(L1, 1, undefined, { mut: (a) => { a["list_card"] = "cd".repeat(32); } })]))).toBe("LIST_APPROVAL_MALFORMED");
    expect(code(check([version(L1, 1, undefined, { mut: (a) => { a["extra"] = 1; } })]))).toBe("LIST_APPROVAL_MALFORMED");
  });
  it("LIST_APPROVAL_HASH_MISMATCH: wrong list, wrong prev hash, version gap, version 1 with prev", () => {
    expect(code(check([{ ...v1, value: [rt("ZZ")] }]))).toBe("LIST_APPROVAL_HASH_MISMATCH");
    expect(code(check([v1, version(L2, 2, v1, { mut: (a) => { a["prev_list_hash"] = H([rt("ZZ")]); } })]))).toBe("LIST_APPROVAL_HASH_MISMATCH");
    expect(code(check([v1, version(L2, 3, v1)]))).toBe("LIST_APPROVAL_HASH_MISMATCH");
    expect(code(check([version(L1, 1, undefined, { mut: (a) => { a["prev_list_hash"] = H(L1); } })]))).toBe("LIST_APPROVAL_HASH_MISMATCH");
    expect(code(check([version(L2, 2, undefined)]))).toBe("LIST_APPROVAL_HASH_MISMATCH"); // v2 without a previous version
  });
  it("LIST_APPROVAL_KEYSET_STALE after a member key rotation (fail closed)", () => {
    expect(code(check([v1], { ...ks0, version: 4 }))).toBe("LIST_APPROVAL_KEYSET_STALE");
  });
  it("LIST_APPROVAL_THRESHOLD: below quorum, duplicates, bad signatures, bad index", () => {
    expect(code(check([version(L1, 1, undefined, { signers: [0, 1, 2] })]))).toBe("LIST_APPROVAL_THRESHOLD");
    expect(code(check([version(L1, 1, undefined, { signers: [0, 0, 0, 0, 0] })]))).toBe("LIST_APPROVAL_THRESHOLD");
    const forged = version(L1, 1, undefined, { signers: [0, 1, 2] });
    const o = JSON.parse(forged.approvalText!);
    o.signatures.push({ key_index: 3, signature: o.signatures[0].signature }); // another member's signature under index 3
    expect(code(check([{ ...forged, approvalText: new TextDecoder().decode(canonicalNotary(o)) }]))).toBe("LIST_APPROVAL_THRESHOLD");
    o.signatures.push({ key_index: 9, signature: o.signatures[0].signature });
    expect(code(check([{ ...forged, approvalText: new TextDecoder().decode(canonicalNotary(o)) }]))).toBe("LIST_APPROVAL_THRESHOLD");
  });

  describe("emergency retirement (rule E)", () => {
    const retired = (pcr: string, at: string) => rt(pcr, { retire_reason: "vulnerable", retired_at: at });
    const E2 = [rt("AA"), retired("BB", "2026-11-01T00:00:00Z")];
    it("two members may retire a runtime as vulnerable, on top of an approved standard version", () => {
      const e = version(E2, 3, v2, { kind: "emergency_retirement", signers: [0, 1] });
      expect(check([v1, v2, e])).toMatchObject({ ok: true, listVersion: 3, list: E2 });
    });
    it("a chain of emergency versions verifies back to the standard one; the standard one still needs quorum", () => {
      const e3 = version(E2, 3, v2, { kind: "emergency_retirement", signers: [0, 1] });
      const E3 = [retired("AA", "2026-11-02T00:00:00Z"), retired("BB", "2026-11-01T00:00:00Z")];
      const e4 = version(E3, 4, e3, { kind: "emergency_retirement", signers: [2, 3] });
      expect(check([v1, v2, e3, e4]).ok).toBe(true);
      const weakBase = version(L2, 2, v1, { signers: [0, 1] }); // only 2 of 4 on the base
      const e3w = version(E2, 3, weakBase, { kind: "emergency_retirement", signers: [0, 1] });
      expect(code(check([v1, weakBase, e3w]))).toBe("LIST_APPROVAL_THRESHOLD");
    });
    it("LIST_APPROVAL_NOT_REMOVAL_ONLY: adding an entry, reversing a retirement, moving retired_at later, changing a field", () => {
      const em = (value: unknown[], prev: ListVersion) => version(value, 3, prev, { kind: "emergency_retirement", signers: [0, 1] });
      expect(code(check([v1, v2, em([...L2, rt("CC")], v2)]))).toBe("LIST_APPROVAL_NOT_REMOVAL_ONLY");
      const base = version(E2, 3, v2, { signers: [0, 1, 2, 3] });
      expect(code(check([v1, v2, base, version([rt("AA"), rt("BB")], 4, base, { kind: "emergency_retirement", signers: [0, 1] })]))).toBe("LIST_APPROVAL_NOT_REMOVAL_ONLY");
      expect(code(check([v1, v2, base, version([rt("AA"), retired("BB", "2026-12-01T00:00:00Z")], 4, base, { kind: "emergency_retirement", signers: [0, 1] })]))).toBe("LIST_APPROVAL_NOT_REMOVAL_ONLY");
      expect(code(check([v1, v2, em([rt("AA"), retired("BB", "2026-11-01T00:00:00Z", )].map((e, i) => (i === 1 ? { ...e, version: "2" } : e)), v2)]))).toBe("LIST_APPROVAL_NOT_REMOVAL_ONLY");
      expect(code(check([v1, v2, em([retired("BB", "2026-11-01T00:00:00Z"), rt("AA")], v2)]))).toBe("LIST_APPROVAL_NOT_REMOVAL_ONLY"); // reordered
      expect(code(check([v1, v2, em(L2, v2)]))).toBe("LIST_APPROVAL_NOT_REMOVAL_ONLY"); // nothing changed
    });
    it("one member is not enough for an emergency update", () => {
      expect(code(check([v1, v2, version(E2, 3, v2, { kind: "emergency_retirement", signers: [0] })]))).toBe("LIST_APPROVAL_THRESHOLD");
    });
    it("isRemovalOnly on program allowlists matches by program_cid", () => {
      const a = [{ program_cid: "p1", name: "x" }], b = [{ program_cid: "p1", name: "x", retire_reason: "vulnerable", retired_at: "2026-11-01T00:00:00Z" }];
      expect(isRemovalOnly(a, b, "program_cid")).toBe(true);
      expect(isRemovalOnly(a, [{ ...b[0]!, program_cid: "p2" }], "program_cid")).toBe(false);
    });
  });
});

function b64uDecodeLoose(s: string): Uint8Array {
  return Uint8Array.from(Buffer.from(s, "base64url"));
}
