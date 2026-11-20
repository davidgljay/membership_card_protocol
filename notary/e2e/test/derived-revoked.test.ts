/**
 * Step 6.5: a propagated revocation is an ordinary revocation to a verifier. The cards and the revocation batch are the
 * ones a real broker produced under `sealed_link` (`notary/vectors/derived/revoked.json`, written by
 * `notary-broker/tests/derive.rs` with NOTARY_WRITE_VECTORS=1): four derived cards registered, then two revoked by one
 * `BatchUpdateCardHeads` (820 for a quiet source revocation, 920 for a loud one). Here every submission is replayed through
 * the simulated chain's write gate (`src/sim-chain.ts`: press signature, sequence, step 8 calldata binding, and for the
 * batch the `updates` list and each card's current head), then `CardVerifier.verifyCard` reads each card.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { keccak_256, sha3_256 } from "@noble/hashes/sha3";
import { hkdf } from "@noble/hashes/hkdf";
import { CardVerifier } from "@membership-card-protocol/verifier";
import { b64uDecode, b64uEncode, canonicalNotary } from "@membership-card-protocol/verifier/notary";
import { createSimChain } from "../src/sim-chain.ts";

const fx = JSON.parse(readFileSync(new URL("../../vectors/derived/revoked.json", import.meta.url), "utf8"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const contentKey = (pub: Uint8Array) => hkdf(sha3_256, pub, undefined, new TextEncoder().encode("card-content-v1"), 32);
const open = (pub: Uint8Array, b: Uint8Array) => {
  const d = createDecipheriv("aes-256-gcm", contentKey(pub), b.subarray(0, 12));
  d.setAuthTag(b.subarray(b.length - 16));
  return JSON.parse(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString());
};
const seal = (pub: Uint8Array, o: unknown) => {
  const n = new Uint8Array(12).fill(7);
  const c = createCipheriv("aes-256-gcm", contentKey(pub), n);
  return new Uint8Array(Buffer.concat([n, c.update(Buffer.from(JSON.stringify(o))), c.final(), c.getAuthTag()]));
};

const tpub = b64uDecode(fx.template_pubkey, 1312);
const T_ADDR = hex(keccak_256(tpub));
const notary = fx.genesis;
const kid = b64uDecode(notary.id_pubkey, 1312);
const chainKey = b64uDecode(notary.chain_pubkey, 64);
type Sub = { op: string; payload: Record<string, unknown>; signature: string; calldata: Record<string, unknown> };
const subs = fx.submissions as Sub[];
const registrations = subs.filter((s) => s.op === "register_card");
const batches = subs.filter((s) => s.op === "batch_update_card_heads");

let chain: ReturnType<typeof createSimChain>;
let verifier: CardVerifier;

function rpc(c: typeof chain) {
  return {
    getCardEntry: async (a: string) => { const x = c.card(a); return x ? { log_head_cid: x.head_cid, policy_address: c.policyCards.get(x.policy) ?? x.policy, last_press_address: x.press, forward_to: null, exists: true } : null; },
    isPolicyAuthorizer: async (a: string) => [...c.policyCards.values()].includes(a),
    getPressAuthorization: async (policy: string, press: string) => { const p = c.pressAuth(policy, press); return p ? { press_public_key: p.press_public_key, mldsa44_key_hash: "", active: p.active, authorized_at: "2027-01-01T00:00:00Z", revoked_at: null } : null; },
    getSubCardEntry: async () => null,
    getCardEventLog: async (a: string) => (c.card(a)?.events ?? []).map((e: { cid: string; timestamp: string }) => ({ cid: e.cid, timestamp: e.timestamp })),
    getEasAnnotations: async () => [],
  };
}

afterAll(() => { vi.useRealTimers(); });

beforeAll(() => {
  // the verifier reads chain time from its own clock: the broker's simulated time, an hour after the fixture was written
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(fx.now_ms + 3_600_000);
  chain = createSimChain({ blockMs: 3_600_000 });
  for (const [cid, b] of Object.entries(fx.ipfs as Record<string, string>)) chain.ipfs.set(cid, b64uDecode(b));
  const tHead = chain.pin(seal(tpub, { ancestry_pubkeys: [], policy_id: fx.template_policy_id, recipient_pubkey: fx.template_pubkey }));
  chain.registerCard({ address: T_ADDR, policy: "root", press: "00".repeat(32), head_cid: tHead });
  chain.policyCards.set(fx.template_policy_id, T_ADDR);
  const requestCid = chain.pin(canonicalNotary(notary.request));
  chain.pin(b64uDecode(notary.attestation));
  const card = { ...notary.offer, genesis_request: requestCid, operator_host_pubkey: notary.request.operator_host_pubkey, issued_at: new Date(fx.now_ms - 86_400_000).toISOString(), ancestry_pubkeys: [fx.template_pubkey] };
  chain.registerCard({ address: fx.notary_card, policy: "notary-card-policy", press: "11".repeat(32), head_cid: chain.pin(seal(kid, card)) });
  chain.authorizePress(T_ADDR, fx.notary_card, chainKey);
  verifier = new CardVerifier({ rpc: rpc(chain) as never, ipfs: { fetch: async (cid: string) => { const b = chain.ipfs.get(cid); if (!b) throw new Error(`no ${cid}`); return b; } }, trustedRoots: [] });
  for (const r of registrations) expect(chain.submitTx(r as never), "registration").toHaveProperty("tx_hash");
});

describe("the simulated registry's write gate for BatchUpdateCardHeads (registry_contract §4.15, §6.1)", () => {
  it("refuses a changed update, a reordered list, a dropped entry and a bad signature, consuming nothing; then applies the broker's batch", () => {
    expect(batches).toHaveLength(1);
    const b = batches[0]!;
    const ups = b.calldata["updates"] as Record<string, string>[];
    const next = chain.pressAuth(T_ADDR, fx.notary_card)!.next_sequence;
    const junk = b64uEncode(new TextEncoder().encode("bafkreijunk"));
    const tries: [string, Sub][] = [
      ["a host that points a head at junk", { ...b, calldata: { ...b.calldata, updates: [{ ...ups[0]!, new_log_cid: junk }, ...ups.slice(1)] } }],
      ["a reordered list", { ...b, calldata: { ...b.calldata, updates: [...ups].reverse() } }],
      ["a dropped entry", { ...b, calldata: { ...b.calldata, updates: ups.slice(1) } }],
    ];
    for (const [what, m] of tries) expect(chain.submitTx(m as never), what).toEqual({ failed: "PAYLOAD_CALLDATA_MISMATCH" });
    expect(chain.submitTx({ ...b, signature: b64uEncode(new Uint8Array(64).fill(1)) } as never)).toEqual({ failed: "PRESS_SIGNATURE_INVALID" });
    expect(chain.pressAuth(T_ADDR, fx.notary_card)!.next_sequence).toBe(next);
    expect(chain.submitTx(b as never)).toHaveProperty("tx_hash");
    expect(chain.submitTx(b as never)).toEqual({ failed: "SEQUENCE_MISMATCH" });
  });
});

describe("a propagated revocation is a revocation to a verifier", () => {
  // the verifier reads ten minutes after the batch landed (the simulated chain stamps blocks at the frozen clock), well
  // inside the cards' period
  beforeAll(() => { vi.setSystemTime(fx.now_ms + 3_600_000 + 600_000); });
  for (let i = 0; i < 4; i++) {
    it(`card ${i}: ${fx.revoked[i] ?? "not revoked"}`, async () => {
      const h = fx.holders[i];
      const dpub = b64uDecode(h.pubkey, 1312);
      const address = hex(keccak_256(dpub));
      const head = chain.card(address)!.head_cid;
      const r = await verifier.verifyCard(address, { pubkey: h.pubkey });
      expect(r.chain_reaches_trusted_root).toBe(true);
      if (fx.revoked[i] === null) {
        expect(r.revocation.status).toBe("not_revoked");
        expect(r.is_currently_valid).toBe(true);
        return;
      }
      // the head is the revocation entry, readable only with the holder's key; the code is the mapped one, no note
      const entry = open(dpub, chain.ipfs.get(head)!);
      expect(entry).toMatchObject({ code: fx.revoked[i], entry_type: "revocation", notify_holder: true });
      expect(entry.revocation.note).toBeUndefined();
      expect(entry.press_signature.public_key).toBe(notary.id_pubkey);
      // 820 is read as a quiet revocation, 920 as a loud one (update_codes.md: historical semantics follow the range)
      expect(r.revocation, JSON.stringify(r.revocation)).toMatchObject({ status: fx.revoked[i] === 920 ? "loud_revocation" : "revoked", code: fx.revoked[i] });
      expect(r.is_currently_valid).toBe(false);
    });
  }
});
