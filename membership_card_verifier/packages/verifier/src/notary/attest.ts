/**
 * Algorithm V, shared steps V6–V12 (notary_lifecycle.md A.1; protocol-objects.md §33), and the
 * platform gate. Operates on the parsed result of a platform module (`AttestationVerifier`);
 * **no attestation document parsing here** (G5): AWS and simulator parsing live in
 * `@membership-card-protocol/notary-attestation`.
 *
 * Interface note Q15: `ATT_PLATFORM_NOT_ALLOWED` is raised here, before any platform module runs.
 */
import { parseTimestamp, decodeUserData, b64uEncode, NotaryFormatError } from "./canonical.js";
import type { AcceptedRuntime, AttestationVerifier } from "./types.js";

export interface AttestConfig {
  /** Pinned trust root (DER) per platform. */
  roots: Record<string, Uint8Array>;
  /** `false` in production builds. */
  allowSimulator: boolean;
}

/** What the verifier expects the document to bind (§33): the full 181-byte `user_data` (unused fields zero). */
export interface ExpectedBinding {
  userData: Uint8Array;
  /**
   * The wallet cannot know a replica's instance key (algorithm W step 13 lists no `inst_key_hash`).
   * When true, `inst_key_hash` must be non-zero (it is bound for every purpose) but is not compared.
   * Interface note E10; verifiers that know the instance key leave this unset.
   */
  anyInstanceKey?: boolean;
  /**
   * A notarization verifier cannot know the final-epoch job key (erratum E13, decided): `public_key` must be
   * present (32 bytes) but is not compared. The nonce is still compared.
   */
  anyPublicKey?: boolean;
  /** Absent means the document must carry no nonce / public key. */
  nonce?: Uint8Array;
  publicKey?: Uint8Array;
}

export interface VerifyContext {
  /** Chain time at which PCR0 must be accepted (ms). */
  tEvalMs: number;
  nowMs: number;
  maxAgeMs?: number;
  acceptedRuntimes: AcceptedRuntime[];
  platform: string;
}

export type AttestResult =
  | { ok: true; measurement: Uint8Array; timestampMs: number; warnings: string[] }
  | { ok: false; code: string };

const FUTURE_SKEW_MS = 5 * 60 * 1000;
const eq = (a: Uint8Array | undefined, b: Uint8Array | undefined) =>
  a === undefined || b === undefined ? a === b : a.length === b.length && a.every((x, i) => x === b[i]);

export function verifyAttestation(
  doc: Uint8Array, cfg: AttestConfig, modules: AttestationVerifier[], expected: ExpectedBinding, ctx: VerifyContext,
): AttestResult {
  // platform gate
  const module = modules.find((m) => m.platform === ctx.platform);
  if (!module || (ctx.platform === "simulator" && !cfg.allowSimulator)) return { ok: false, code: "ATT_PLATFORM_NOT_ALLOWED" };
  const root = cfg.roots[ctx.platform];
  if (!root) return { ok: false, code: "ATT_PLATFORM_NOT_ALLOWED" };
  // V1–V5
  const env = module.verifyEnvelope(doc, root);
  if (!env.ok) return { ok: false, code: env.code };
  // V6: debug mode
  const zero = (i: number) => env.pcrs.get(i)?.every((b) => b === 0) === true;
  if (zero(0) && zero(1) && zero(2)) return { ok: false, code: "ATT_DEBUG_MODE" };
  // V7: PCR0 accepted at t_eval
  const m64 = b64uEncode(env.measurement);
  const warnings: string[] = [];
  const hit = ctx.acceptedRuntimes.find((r) =>
    r.pcr0 === m64 && r.platform === ctx.platform && parseTimestamp(r.accepted_from) <= ctx.tEvalMs &&
    (r.retired_at === undefined || ctx.tEvalMs < parseTimestamp(r.retired_at)));
  if (!hit) return { ok: false, code: "ATT_RUNTIME_NOT_ACCEPTED" };
  if (hit.retire_reason === "vulnerable") warnings.push("runtime_retired_vulnerable");
  // V8–V9: user_data layout and purpose
  let purpose: number;
  try { purpose = decodeUserData(env.userData).purpose; } catch (e) {
    if (e instanceof NotaryFormatError) return { ok: false, code: "ATT_USER_DATA_MALFORMED" };
    throw e;
  }
  if (purpose !== decodeUserData(expected.userData).purpose) return { ok: false, code: "ATT_PURPOSE_MISMATCH" };
  // V10: bound fields equal, unused fields zero (the expected binding carries zeros there)
  if (expected.anyInstanceKey) {
    const inst = env.userData.subarray(76, 108);
    if (inst.every((b) => b === 0)) return { ok: false, code: "ATT_BINDING_MISMATCH" };
    const mask = (u: Uint8Array) => Uint8Array.from(u, (b, i) => (i >= 76 && i < 108 ? 0 : b));
    if (!eq(mask(env.userData), mask(expected.userData))) return { ok: false, code: "ATT_BINDING_MISMATCH" };
  } else if (!eq(env.userData, expected.userData)) return { ok: false, code: "ATT_BINDING_MISMATCH" };
  // V11: nonce and public_key
  if (!eq(env.nonce, expected.nonce)) return { ok: false, code: "ATT_NONCE_MISMATCH" };
  if (expected.anyPublicKey ? env.publicKey === undefined || env.publicKey.length !== 32 : !eq(env.publicKey, expected.publicKey))
    return { ok: false, code: "ATT_KEY_MISMATCH" };
  // V12: freshness
  if (ctx.maxAgeMs !== undefined && (env.timestamp < ctx.nowMs - ctx.maxAgeMs || env.timestamp > ctx.nowMs + FUTURE_SKEW_MS))
    return { ok: false, code: "ATT_STALE" };
  return { ok: true, measurement: env.measurement, timestampMs: env.timestamp, warnings };
}
