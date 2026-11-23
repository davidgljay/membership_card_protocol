/**
 * The leaky program's policy (Phase 7.2): the test-only `leaky-test` template (`notary/templates/leaky-test`), built on demand
 * by `run-hostile.sh`. It runs under `dedicated` isolation because it is, deliberately, on no allowlist.
 */
import { readFileSync } from "node:fs";
import { canonicalNotary, cidOfBytes } from "@membership-card-protocol/verifier/notary";
import { K, key, IDS, NOTARY_SECTION, PRESS_ADDR, encrypt } from "../src/world.ts";
import type { ChainWrites } from "../src/world.ts";

export const LEAK_KEY = key("leaky-policy");
const TEMPLATE = new URL("../../templates/", import.meta.url);
export const LEAK_MODULE = new Uint8Array(readFileSync(new URL("modules/leaky-test.wasm", TEMPLATE)));
export const LEAK_PROGRAM_CID = cidOfBytes(LEAK_MODULE);
const SCHEMA = JSON.parse(readFileSync(new URL("leaky-test/schema.json", TEMPLATE), "utf8")) as unknown;
const { output_recipients: _o, ...BASE } = NOTARY_SECTION as Record<string, unknown>;
export const LEAK_SECTION = { ...BASE, isolation: "dedicated", input_replacement: "reject_duplicates", output_schema: SCHEMA, program_cid: LEAK_PROGRAM_CID,
  parameter_bounds: [{ name: "mode", type: "text", required: true, description: "What the program does", regex: "^(honest|exact|exfiltrate)$" }],
  output_recipients: { cards: [] as string[], job_requester: false, public: true }, privacy: { k_min: 3 } };
export const leakGenesis = { ancestry_pubkeys: [K.root.b64], approved_notaries: [] as string[], issued_at: "2026-01-01T00:00:00.000Z", issuer_card: "x", notary: LEAK_SECTION, policy_id: IDS.metaPolicy, recipient_pubkey: LEAK_KEY.b64 };
export const LEAK_ID = cidOfBytes(canonicalNotary(leakGenesis as never));

/** Registers the policy and approves the notary cards; returns the state CID. */
export async function registerLeaky(c: ChainWrites, notaryCards: string[]): Promise<string> {
  await c.pin(canonicalNotary(leakGenesis as never));
  await c.pin(LEAK_MODULE);
  const genesis = await c.pin(encrypt(LEAK_KEY.pub, leakGenesis, "leaky-genesis"));
  await c.registerCard({ address: LEAK_KEY.addr, policy: IDS.metaPolicy, press: PRESS_ADDR, head_cid: genesis });
  const entry = { card_state: { approved_notaries: notaryCards }, code: 300, entry_type: "field_update", history: [genesis], prev_log_root: genesis, version: 1 };
  const head = await c.pin(encrypt(LEAK_KEY.pub, entry, `leaky-approve-${notaryCards.join("-")}`));
  await c.registerCard({ address: LEAK_KEY.addr, policy: IDS.metaPolicy, press: PRESS_ADDR, head_cid: head });
  return head;
}
