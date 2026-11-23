/**
 * `eas-schema` (notary-code-plan.md §3.6): deploy EAS into the integration stack's devnode and register the notary job-log
 * schema, `(bytes32 job_hash, uint64 seq, string record_cid)` (erratum E16), non-revocable, no resolver.
 *
 * DEVNODE ONLY (CP7). Running it against anything but a local RPC URL is refused, whatever the flags say: a production
 * schema registration is a separate act that needs David's approval and its own script run.
 *
 *   node --experimental-strip-types governance/scripts/notary-eas.ts deploy \
 *     --rpc http://localhost:8547 --key 0x<gas wallet key> --artifacts <dir with @ethereum-attestation-service/eas-contracts> \
 *     [--out contracts/deployments/local-eas.json]
 *
 * The contracts are EAS 1.9.0's compiled artifacts (MIT), deployed as shipped; nothing is compiled or modified here.
 */
import { createPublicClient, createWalletClient, http, encodeAbiParameters, encodePacked, keccak256, parseAbi, zeroAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const NOTARY_SCHEMA = "bytes32 job_hash, uint64 seq, string record_cid";
const REGISTRY_ABI = parseAbi(["function register(string schema, address resolver, bool revocable) returns (bytes32)"]);

export function assertLocalRpc(rpc: string): void {
  if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|nitro-devnode)(:\d+)?(\/|$)/.test(rpc)) throw new Error(`refusing a non-local RPC URL (devnode only, CP7): ${rpc}`);
}

/** EAS's schema UID: `keccak256(abi.encodePacked(schema, resolver, revocable))`. */
export const schemaUid = (schema = NOTARY_SCHEMA, resolver: Hex = zeroAddress, revocable = false): Hex => keccak256(encodePacked(["string", "address", "bool"], [schema, resolver, revocable]));

export interface EasDeployment { eas: Hex; schemaRegistry: Hex; schemaUid: Hex; schema: string; schemaBlock: number; deployedAt: string }

export async function deployEas(o: { rpc: string; key: string; artifacts: string }): Promise<EasDeployment> {
  assertLocalRpc(o.rpc);
  const art = (n: string) => JSON.parse(readFileSync(join(o.artifacts, `@ethereum-attestation-service/eas-contracts/artifacts/contracts/${n}.sol/${n}.json`), "utf8")) as { abi: never; bytecode: Hex };
  const account = privateKeyToAccount((o.key.startsWith("0x") ? o.key : `0x${o.key}`) as Hex);
  const pub = createPublicClient({ transport: http(o.rpc) });
  const wallet = createWalletClient({ account, transport: http(o.rpc) });
  const deploy = async (a: { abi: never; bytecode: Hex }, args: unknown[] = []) => {
    const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args: args as never, chain: null });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success" || !r.contractAddress) throw new Error(`deployment failed: ${hash}`);
    return r.contractAddress;
  };
  const schemaRegistry = await deploy(art("SchemaRegistry"));
  const eas = await deploy(art("EAS"), [schemaRegistry]);
  const hash = await wallet.writeContract({ address: schemaRegistry, abi: REGISTRY_ABI, functionName: "register", args: [NOTARY_SCHEMA, zeroAddress, false], chain: null });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error("schema registration failed");
  return { eas, schemaRegistry, schemaUid: schemaUid(), schema: NOTARY_SCHEMA, schemaBlock: Number(r.blockNumber), deployedAt: new Date().toISOString() };
}

void encodeAbiParameters;

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  if (process.argv[2] !== "deploy") { console.error("usage: notary-eas.ts deploy --rpc URL --key HEX --artifacts DIR [--out FILE]"); process.exit(2); }
  const rpc = arg("--rpc"), key = arg("--key"), artifacts = arg("--artifacts");
  if (!rpc || !key || !artifacts) { console.error("--rpc, --key and --artifacts are required"); process.exit(2); }
  const d = await deployEas({ rpc, key, artifacts });
  const out = arg("--out");
  if (out) writeFileSync(out, JSON.stringify({ network: "local", rpc_url: rpc, ...d }, null, 2) + "\n");
  console.log(JSON.stringify(d, null, 2));
}
