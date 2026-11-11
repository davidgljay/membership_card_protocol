// protocol-objects.md §8.1 (DCQL include_children) and §2 (preferred_services
// inheritance), driven by the policy_tree cases in specs/login-conformance.json.
import { describe, it, expect, vi } from "vitest";
import { generateKeypair, encryptForCard } from "../fixtures.js";
import { matchMcardQuery, effectivePreferredServices, type ChainContext } from "../../src/login/chain.js";
import type { RpcProvider, IpfsProvider } from "../../src/types.js";
import { loginVectors } from "./conformance.test.js";

type Tree = Record<string, { parent: string | null; preferred_services?: unknown[] }>;
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64url");
const json = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

function buildTree(tree: Tree) {
  const blobs: Record<string, Uint8Array> = {};
  const heads: Record<string, string> = {};
  const policyKp: Record<string, ReturnType<typeof generateKeypair>> = {};
  for (const name of Object.keys(tree)) policyKp[name] = generateKeypair();
  // For each non-root policy, an issuer card issued under its parent policy.
  const snapshot = (name: string) => {
    const node = tree[name]!;
    const ancestry: string[] = [];
    if (node.parent) {
      const issuer = generateKeypair();
      const issuerDoc = { policy_id: `Qm-${node.parent}`, ancestry_pubkeys: [], recipient_pubkey: b64(issuer.publicKey) };
      blobs[`Qm-issuer-${name}`] = encryptForCard(issuer.publicKey, json(issuerDoc));
      heads[issuer.address] = `Qm-issuer-${name}`;
      ancestry.push(b64(issuer.publicKey));
    }
    return {
      recipient_pubkey: b64(policyKp[name]!.publicKey),
      ancestry_pubkeys: ancestry,
      ...(node.preferred_services !== undefined ? { preferred_services: node.preferred_services } : {}),
    };
  };
  for (const name of Object.keys(tree)) {
    const snap = snapshot(name);
    blobs[`Qm-${name}`] = json(snap); // plaintext snapshot at policy_id
    blobs[`Qm-${name}-head`] = encryptForCard(policyKp[name]!.publicKey, json(snap)); // live head
    heads[policyKp[name]!.address] = `Qm-${name}-head`;
  }
  const rpc = {
    getCardEntry: vi.fn().mockImplementation((a: string) => Promise.resolve(heads[a] ? { exists: true, log_head_cid: heads[a], policy_address: "0x", last_press_address: "0x", forward_to: null } : null)),
  } as unknown as RpcProvider;
  const ipfs: IpfsProvider = { fetch: vi.fn().mockImplementation((cid: string) => (blobs[cid] ? Promise.resolve(blobs[cid]) : Promise.reject(new Error(cid)))) };
  const ctx: ChainContext = { rpc, ipfs };
  const card = (policy: string) => ({ policy_id: `Qm-${policy}` });
  return { ctx, card, address: (name: string) => policyKp[name]!.address };
}

const tree = loginVectors.policy_tree as Tree;

describe("§8.1 DCQL mcard policy match — login-conformance.json dcql_match", () => {
  const t = buildTree(tree);
  for (const c of loginVectors.dcql_match) {
    it(`${c.id}: card under ${c.card_policy}, query ${JSON.stringify(c.query)} → ${c.expected_match}`, async () => {
      const query = { id: "m", format: "mcard" as const, meta: { policies: c.query.map((q: { id: string; include_children: boolean }) => ({ id: t.address(q.id), include_children: q.include_children })) } };
      const r = await matchMcardQuery(t.card(c.card_policy), query, t.ctx);
      if (c.expected_match === null) expect(r.matched).toBe(false);
      else expect(r).toEqual({ matched: true, policy: t.address(c.expected_match) });
    });
  }
  it("a predicate in the query never matches (predicate engine not yet shared)", async () => {
    const query = { id: "m", format: "mcard" as const, meta: { policies: [{ id: t.address("root"), include_children: true }], predicate: { is_holder: true } } };
    expect(await matchMcardQuery(t.card("root"), query, t.ctx)).toEqual({ matched: false, reason: "PREDICATE_NOT_SUPPORTED" });
  });
});

describe("§2 preferred_services inheritance — login-conformance.json preferred_services", () => {
  const t = buildTree(tree);
  for (const c of loginVectors.preferred_services) {
    it(`${c.id}: ${c.description}`, async () => {
      expect(await effectivePreferredServices(t.card(c.card_policy), t.ctx)).toEqual(c.expected);
    });
  }
});

describe("§8.1 own policy from the on-chain CardEntry.policy_address", () => {
  it("matches when the policy snapshot has no key but the chain records the policy address", async () => {
    const rpc = { getCardEntry: vi.fn().mockResolvedValue({ exists: true, log_head_cid: "x", policy_address: "0x" + "ab".repeat(32), last_press_address: "0x", forward_to: null }) } as unknown as RpcProvider;
    const ipfs: IpfsProvider = { fetch: vi.fn().mockResolvedValue(new TextEncoder().encode(JSON.stringify({ field_definitions: {} }))) };
    const q = (include_children: boolean) => ({ id: "m", format: "mcard" as const, meta: { policies: [{ id: "ab".repeat(32), include_children }] } });
    expect(await matchMcardQuery({ policy_id: "bafy" }, q(false), { rpc, ipfs }, "cd".repeat(32))).toEqual({ matched: true, policy: "ab".repeat(32) });
    expect(await matchMcardQuery({ policy_id: "bafy" }, q(false), { rpc, ipfs })).toEqual({ matched: false, reason: "POLICY_UNRESOLVED" });
  });
});
