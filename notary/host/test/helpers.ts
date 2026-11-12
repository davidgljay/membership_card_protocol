import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha256";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { b64uEncode, H } from "@membership-card-protocol/wallet-sdk/notary-types";
import { createContext } from "../src/context.js";
import type { HostContext } from "../src/context.js";
import { createInMemoryKv } from "../src/kv.js";
import { MockEnclave } from "../src/enclave/mock.js";
import type { MockScript } from "../src/enclave/mock.js";
import { EnclaveSession } from "../src/enclave/transport.js";
import { attachEnclave } from "../src/handlers/enclave-requests.js";
import { memoryServices } from "../src/testing.js";
import { hostKeys } from "../src/receipts/index.js";

const VEC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "vectors", "objects");
export const vec = (n: string) => JSON.parse(readFileSync(join(VEC, `${n}.json`), "utf8")).cases[0].input as Record<string, any>;

export const job = vec("job");
export const sealed = vec("sealed_input");
export const JOB_HASH = H(job);
export const NOTARY_CARD: string = job["replica_set"][0].notary_card;
export const HOST_SEED = sha256(new TextEncoder().encode("host-test-key"));
export const hostPublicKey = b64uEncode(hostKeys(HOST_SEED).publicKey);
export const PROGRAM = new TextEncoder().encode("(module)-test-program-bytes");

export const kEnclaveInst = b64uEncode(sha256(new TextEncoder().encode("instance-1")));

export async function harness(script: MockScript = {}, over: { cardAddresses?: string[]; peers?: string[] } = {}) {
  const kv = createInMemoryKv();
  const svc = memoryServices();
  const programCid = await svc.ipfs.pin(PROGRAM);
  svc.policies.set(job["policy_id"], null as never);
  svc.policies.set(job["policy_id"], {
    notary: { program_cid: programCid, platform: "aws-nitro-enclaves", mode: "aggregate", isolation: "shared", privacy: { k_min: 5 } } as never,
    approvedNotaries: [NOTARY_CARD],
  });
  const enclave = new MockEnclave(script);
  const session = new EnclaveSession("cid-1", enclave, 200);
  let now = Date.parse("2026-11-12T10:00:00Z");
  const ctx: HostContext = createContext({
    config: { NOTARY_CARD_ADDRESSES: over.cardAddresses ?? [NOTARY_CARD], NOTARY_HOST_MLDSA44_SEED: HOST_SEED, NOTARY_OHTTP_PRIVATE_KEY: new Uint8Array(32).fill(1), NOTARY_RELAY_TARGET_ID: "notary-a", NOTARY_PUBLIC_BASE_URL: "https://notary.example",
      PEER_HOSTS: over.peers ?? ["https://peer.example"], NOTARY_ADMIN_TOKEN: "t".repeat(40) },
    kv, ipfs: svc.ipfs, eas: svc.eas, chain: svc.chain, submitter: svc.submitter, policies: svc.policies, peers: svc.peers, delivery: svc.delivery, replicas: svc.replicas,
    monitor: svc.monitor, sessions: new Map([["cid-1", session]]), now: () => now,
  });
  ctx.instances.set(kEnclaveInst, session);
  attachEnclave(ctx, session);
  return { ctx, kv, svc, enclave, session, programCid, tick: (ms: number) => { now += ms; } };
}

export const flush = () => new Promise((r) => setTimeout(r, 5));

export const verifyHostSig = (obj: Record<string, any>) => {
  const { host_signature, ...rest } = obj;
  return ml_dsa44.verify(Buffer.from(host_signature.signature, "base64url"), new TextEncoder().encode(JSON.stringify(sortKeys(rest))), Buffer.from(host_signature.public_key, "base64url"));
};
const sortKeys = (v: any): any => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
