import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { b64uDecode, verifyGenesis } from "@membership-card-protocol/verifier/notary";
import type { AcceptedRuntime, GenesisRequest } from "@membership-card-protocol/verifier/notary";
import { simulator, awsNitroEnclaves } from "../src/index.ts";

const VEC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "vectors");
const load = (f: string) => JSON.parse(readFileSync(join(VEC, f), "utf8"));
const request = load("objects/genesis_request.json").cases[0].input as GenesisRequest & { platform: "simulator" };
const fx = load("attestation/genesis_attestations.json");
const accepted: AcceptedRuntime[] = [{ accepted_from: "2026-01-01T00:00:00Z", build_recipient: "", build_recipe_cid: "x", close_compat: "c", pcr0: fx.accepted_pcr0, platform: "simulator", source_commit: "s", version: "1" } as never];
const base = {
  request: { ...request, platform: "simulator" } as GenesisRequest,
  offer: { recipient_pubkey: request.id_pubkey, chain_pubkey: request.chain_pubkey, genesis_attestation: "bafkreiabc", operator_card: request.operator_card },
  checks: { attestationDoc: b64uDecode(fx.docs.good), operatorCardValid: async () => true },
  cfg: { roots: { simulator: b64uDecode(fx.trust_root) }, allowSimulator: true }, modules: [simulator, awsNitroEnclaves], acceptedRuntimes: accepted,
  tEvalMs: fx.now_ms, nowMs: fx.now_ms + 3600_000, maxAgeMs: 7 * 86_400_000,
};
const code = async (over: object = {}, doc?: string) => {
  const r = await verifyGenesis({ ...base, ...over, checks: { ...base.checks, ...(doc ? { attestationDoc: b64uDecode(fx.docs[doc]) } : {}), ...((over as { checks?: object }).checks ?? {}) } } as never);
  return r.ok ? "ok" : r.code;
};

describe("algorithm G (notary_lifecycle.md A.3)", () => {
  it("accepts a genuine genesis attestation, for the holder (7-day max_age) and later verifiers (no max_age)", async () => {
    expect(await code()).toBe("ok");
    expect(await code({ maxAgeMs: undefined, nowMs: fx.now_ms + 400 * 86_400_000 })).toBe("ok");
  });
  it("rejects a stale attestation for the holder", async () => expect(await code({ nowMs: fx.now_ms + 8 * 86_400_000 })).toBe("ATT_STALE"));
  it("rejects an attestation made for another genesis request (nonce)", async () => expect(await code({}, "wrong_nonce")).toBe("ATT_NONCE_MISMATCH"));
  it("rejects a different chain key or id key than the request", async () => {
    expect(await code({}, "wrong_chain_key")).toBe("ATT_BINDING_MISMATCH");
    expect(await code({}, "wrong_id_key")).toBe("ATT_BINDING_MISMATCH");
  });
  it("rejects an attestation that carries a public_key (not used for purpose 0x01)", async () => expect(await code({}, "has_public_key")).toBe("ATT_KEY_MISMATCH"));
  it("rejects debug mode and unaccepted runtimes", async () => {
    expect(await code({}, "debug")).toBe("ATT_DEBUG_MODE");
    expect(await code({}, "other_pcr0")).toBe("ATT_RUNTIME_NOT_ACCEPTED");
  });
  it("NOT_GENESIS_MISMATCH when the offer's keys differ from the request", async () => {
    expect(await code({ offer: { ...base.offer, recipient_pubkey: request.chain_pubkey } })).toBe("NOT_GENESIS_MISMATCH");
    expect(await code({ offer: { ...base.offer, chain_pubkey: request.id_pubkey } })).toBe("NOT_GENESIS_MISMATCH");
    expect(await code({ offer: { ...base.offer, operator_card: "00".repeat(32) } })).toBe("NOT_GENESIS_MISMATCH");
  });
  it("NOT_OPERATOR_INVALID when the operator card does not resolve or is revoked", async () => expect(await code({ checks: { operatorCardValid: async () => false } })).toBe("NOT_OPERATOR_INVALID"));
  it("the simulator is refused in a production configuration", async () => expect(await code({ cfg: { ...base.cfg, allowSimulator: false } })).toBe("ATT_PLATFORM_NOT_ALLOWED"));
});
