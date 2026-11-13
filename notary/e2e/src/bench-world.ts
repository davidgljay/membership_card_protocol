/**
 * The step 5.6 capacity benchmark's card world: the e2e world (`world.ts`) with N contributors, written as one JSON
 * file for `notary/runtime/benches/capacity`. Contributor and sub-card keys come from the same seeds, so the Rust side
 * derives the signing keys itself (`card-notary-e2e-key-member-<i>-sub`).
 *
 *   node --experimental-strip-types src/bench-world.ts --contributors 10000 --out /tmp/bench-world.json
 */
import { writeFileSync } from "node:fs";
import { createSimChain } from "./sim-chain.ts";
import { registerWorld, K, IDS, contributor } from "./world.ts";

const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const n = Number(arg("--contributors") ?? 1000);
const out = arg("--out") ?? "bench-world.json";

const chain = createSimChain({ blockMs: 3_600_000 });
const writes = {
  pin: async (b: Uint8Array) => chain.pin(b),
  registerCard: async (c: Parameters<typeof chain.registerCard>[0]) => chain.registerCard(c),
  registerSub: async (s: Parameters<typeof chain.registerSub>[0]) => chain.registerSub(s),
};
const t0 = Date.now();
await registerWorld(writes, n);
chain.stop();
const world = chain.world();
// the whole-policy snapshot a host would send for the contributors' template policy (notary_host.md §8)
const entries = Object.entries(world.cards).filter(([, c]) => c.policy_address === IDS.sourcePolicy).map(([address, c]) => ({ address, head_cid: c.log_head_cid, last_press: c.last_press_address, events: c.events }));
const snapshot = {
  policy_address: IDS.sourcePolicy, at_block: chain.blocks.length, entries,
  subcards: Object.entries(world.subcards).map(([sub, s]) => ({ master_card: s.master_card_address, sub_card: sub, sub_card_doc_cid: s.sub_card_doc_cid, active: s.active })),
  // `heads` (the head bytes) are filled in by the benchmark from `world.ipfs`
};
writeFileSync(out, JSON.stringify({
  contributors: Array.from({ length: n }, (_, i) => ({ card: contributor(i).card.addr, card_pubkey: contributor(i).card.b64, sub_seed_name: `member-${i}-sub` })),
  source_policy: IDS.sourcePolicy, trusted_roots: [K.root.addr], app_certification_root: K.appRoot.addr, login_service_root: K.loginRoot.addr,
  world, snapshot,
}));
console.log(`wrote ${out}: ${n} contributors, ${Object.keys(world.ipfs).length} objects, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
