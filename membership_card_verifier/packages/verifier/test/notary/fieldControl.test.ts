import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { b64uEncode, canonicalNotary, cidOfBytes } from "../../src/notary/canonical.js";
import { nonDerivableIn, readNonDerivableFields, cardSatisfies, cardChainValid } from "../../src/notary/policy.js";

const vec = (p: string) => JSON.parse(readFileSync(new URL(`../../../../../notary/vectors/${p}`, import.meta.url), "utf8"));
const fc = vec("field_control/cases.json") as { cases: { name: string; policy: Record<string, unknown>; non_derivable: string[] }[] };
type World = { cards: Record<string, { log_head_cid: string; events: { cid: string; timestamp: string }[] }>; subcards: Record<string, unknown>; ipfs: Record<string, string> };
type PolicyCase = { id: string; config: { trustedRoots: string[]; nowIso: string }; policy_id: string; world: World };
const cases = (vec("cards/policy_cases.json") as { cases: PolicyCase[] }).cases;
const get = (id: string) => structuredClone(cases.find((c) => c.id === id)!);

describe("nonDerivableIn: the shared vectors (card_protocol_spec.md §1, 6.5a)", () => {
  it("has the cases", () => expect(fc.cases.length).toBeGreaterThanOrEqual(5));
  for (const c of fc.cases) it(c.name, () => expect(nonDerivableIn(c.policy)).toEqual(c.non_derivable));
});

/** The registered policy with a plain head that updates its field definitions (as `r_head_updated_elsewhere_ok` does). */
function withHead(c: PolicyCase, state: Record<string, unknown>): PolicyCase {
  const [addr, entry] = Object.entries(c.world.cards)[0]!;
  const head = { card_state: state, code: 301, entry_type: "field_update", history: [entry.events[0]!.cid], prev_log_root: "x", version: 1 };
  const bytes = canonicalNotary(head);
  const cid = cidOfBytes(bytes);
  c.world.ipfs[cid] = b64uEncode(bytes);
  c.world.cards[addr] = { ...entry, log_head_cid: cid, events: [...entry.events, { cid, timestamp: "2027-01-01T00:00:00.000Z" }] };
  return c;
}
const read = (c: PolicyCase) => readNonDerivableFields({ policyId: c.policy_id, world: c.world as never, config: c.config });

describe("readNonDerivableFields: the wallet's W6b read at the policy's current head", () => {
  it("a policy with no blocked fields reads as none", async () => expect(await read(get("r_ok"))).toEqual([]));
  it("reads the blocked fields from the CURRENT head, not from the genesis", async () => {
    const c = withHead(get("r_ok"), { field_definitions: [{ name: "rank", type: "text" }, { name: "ssn", type: "text", derivable: false }] });
    expect(await read(c)).toEqual(["ssn"]);
  });
  it("a later head that lifts the block is what counts (the head replaces the state)", async () => {
    const c = withHead(get("r_ok"), { field_definitions: [{ name: "ssn", type: "text", derivable: true }] });
    expect(await read(c)).toEqual([]);
  });
  // Each of these is a policy chain the wallet cannot trust: the read says so (null) instead of reporting "nothing blocked".
  for (const id of ["r_no_trusted_root", "r_policy_revoked", "r_not_registered", "r_genesis_missing", "r_genesis_bytes_not_cid"])
    it(`${id}: null, never an empty list`, async () => expect(await read(get(id))).toBeNull());
  it("a blocked field under an untrusted chain is still null (the answer is not read before the chain is checked)", async () => {
    const c = withHead(get("r_no_trusted_root"), { field_definitions: [{ name: "ssn", type: "text", derivable: false }] });
    expect(await read(c)).toBeNull();
  });
});

// Q6: the wallet's `satisfies` (W5) and a notary read's `chainValid` are the verifier's own chain read, not assumptions.
const pubOf = (c: PolicyCase): { card: string; pubkey: Uint8Array } => {
  const genesis = JSON.parse(Buffer.from(c.world.ipfs[c.policy_id]!, "base64url").toString()) as { recipient_pubkey: string };
  const pubkey = new Uint8Array(Buffer.from(genesis.recipient_pubkey, "base64url"));
  return { pubkey, card: Object.keys(c.world.cards)[0]! };
};
const chainArgs = (c: PolicyCase) => ({ ...pubOf(c), world: c.world as never, config: c.config });

describe("cardChainValid / cardSatisfies: Q6 adapters over the verifier's Stages 3–4", () => {
  it("a card whose chain reaches a trusted root is valid", async () => expect(await cardChainValid(chainArgs(get("r_ok")))).toBe(true));
  for (const id of ["r_no_trusted_root", "r_policy_revoked", "r_not_registered"])
    it(`${id}: chainValid is false (a shortcut that assumes true accepts it)`, async () => expect(await cardChainValid(chainArgs(get(id)))).toBe(false));
  it("a key that does not hash to the card is refused", async () => {
    const c = get("r_ok");
    expect(await cardChainValid({ ...chainArgs(c), pubkey: new Uint8Array(1312).fill(7) })).toBe(false);
  });
  it("satisfies: is_holder is true only for the policy's own card", async () => {
    const c = get("r_ok");
    const a = chainArgs(c);
    expect(await cardSatisfies({ ...a, predicate: { is_holder: true }, policyAddress: a.card })).toBe(true);
    expect(await cardSatisfies({ ...a, predicate: { is_holder: true }, policyAddress: "0x" + "00".repeat(32) })).toBe(false);
  });
  it("satisfies is false on an untrusted chain, whatever the predicate says", async () => {
    const a = chainArgs(get("r_no_trusted_root"));
    expect(await cardSatisfies({ ...a, predicate: { is_holder: true }, policyAddress: a.card })).toBe(false);
  });
  it("an invalid predicate is false", async () => {
    const a = chainArgs(get("r_ok"));
    expect(await cardSatisfies({ ...a, predicate: { nonsense: 1 }, policyAddress: a.card })).toBe(false);
  });
});
