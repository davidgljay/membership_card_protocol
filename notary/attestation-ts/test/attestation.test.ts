import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha256";
import { verifyAttestation, b64uDecode, b64uEncode } from "@membership-card-protocol/verifier/notary";
import type { AcceptedRuntime } from "@membership-card-protocol/verifier/notary";
import { awsNitroEnclaves, simulator, awsNitroRootG1Der } from "../src/index.ts";
import { CborError, decodeCbor } from "../src/cbor.ts";

const FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "vectors", "attestation", "cases.json");
const cases = JSON.parse(readFileSync(FILE, "utf8")).cases as Array<Record<string, any>>;
const modules = [awsNitroEnclaves, simulator];
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();

describe("attestation platform modules judge the Rust-built documents identically", () => {
  it("has the full set of cases (every ATT_* code has a failing fixture)", () => {
    expect(cases.length).toBeGreaterThanOrEqual(45);
    const codes = new Set<string>();
    for (const c of cases) { if (c.envelope_code) codes.add(c.envelope_code); if (c.v?.result && !c.v.result.ok) codes.add(c.v.result.code); }
    for (const code of ["ATT_MALFORMED", "ATT_ROOT_MISMATCH", "ATT_CHAIN_INVALID", "ATT_SIGNATURE_INVALID", "ATT_DEBUG_MODE", "ATT_RUNTIME_NOT_ACCEPTED",
      "ATT_USER_DATA_MALFORMED", "ATT_PURPOSE_MISMATCH", "ATT_BINDING_MISMATCH", "ATT_NONCE_MISMATCH", "ATT_KEY_MISMATCH", "ATT_STALE", "ATT_PLATFORM_NOT_ALLOWED"])
      expect(codes.has(code), code).toBe(true);
  });

  it.each(cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const doc = b64uDecode(c.doc), root = b64uDecode(c.trust_root);
    if (!c.v) {
      // V1–V5 only
      const module = modules.find((m) => m.platform === c.platform)!;
      const r = module.verifyEnvelope(doc, root);
      expect(r.ok ? "ok" : r.code, c.description).toBe(c.envelope_code);
      return;
    }
    const v = c.v;
    const accepted: AcceptedRuntime[] = v.accepted_runtimes.map((r: any) => ({
      accepted_from: new Date(r.accepted_from_ms).toISOString(), build_recipe_cid: "", close_compat: "", pcr0: r.pcr0, platform: r.platform,
      source_commit: "", version: "",
      ...(r.retired_at_ms !== undefined ? { retired_at: new Date(r.retired_at_ms).toISOString() } : {}),
      ...(r.retire_reason ? { retire_reason: r.retire_reason } : {}),
    }));
    const expected = { userData: b64uDecode(v.expected.user_data), ...(v.expected.nonce ? { nonce: b64uDecode(v.expected.nonce) } : {}),
      ...(v.expected.public_key ? { publicKey: b64uDecode(v.expected.public_key) } : {}) };
    const out = verifyAttestation(doc, { roots: { [c.platform]: root }, allowSimulator: c.allow_simulator }, modules, expected,
      { tEvalMs: v.t_eval_ms, nowMs: v.now_ms, ...(v.max_age_ms !== null ? { maxAgeMs: v.max_age_ms } : {}), acceptedRuntimes: accepted, platform: c.platform });
    if (v.result.ok) { expect(out.ok, c.description).toBe(true); if (out.ok) expect(out.warnings).toEqual(v.result.warnings); }
    else expect(out.ok ? "ok" : out.code, c.description).toBe(v.result.code);
  });
});

describe("AWS root and CBOR strictness", () => {
  it("embedded AWS root matches the fingerprint AWS documents", () => {
    expect(hex(sha256(awsNitroRootG1Der()))).toBe("641A0321A3E244EFE456463195D606317ED7CDCC3C1756E09893F3C68F79BB5B");
  });
  it("the strict CBOR decoder rejects indefinite lengths, floats, undefined, trailing bytes", () => {
    for (const bad of [[0x9f, 0xff], [0xf9, 0x3c, 0x00], [0xf7], [0x00, 0x00], [0x5f, 0xff], [0x18], [0x41]])
      expect(() => decodeCbor(Uint8Array.from(bad)), bad.join(",")).toThrow(CborError);
    expect(decodeCbor(Uint8Array.from([0x82, 0x01, 0x20]))).toEqual([1, -1]);
    expect(b64uEncode(decodeCbor(Uint8Array.from([0x42, 1, 2])) as Uint8Array)).toBe("AQI");
  });
});
