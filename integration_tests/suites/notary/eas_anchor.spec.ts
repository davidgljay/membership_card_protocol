/**
 * The notary host's EAS anchorer (`notary/host/src/chain/rpc.ts`, `eas`) against EAS deployed on the local nitro-devnode
 * (Phase 7, 7.1, Q7). Devnode only (CP7).
 *
 * The anchorer writes with viem from the gas wallet; the verifier side reads with the production reader
 * (`EthersEasReader` + `collectNotaryLogAnchors`, ethers), so a pass here means the two sides agree on the schema, the
 * ABI encoding (erratum E16) and the scope (job_hash or notary card address).
 *
 * EAS is deployed by `governance/scripts/notary-eas.ts` from EAS 1.9.0's compiled artifacts. Set `EAS_CONTRACTS_DIR` to a
 * directory that contains `@ethereum-attestation-service/eas-contracts` (for example the `node_modules` of
 * `npm pack @ethereum-attestation-service/eas-contracts@1.9.0` unpacked). The suite skips without it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import type { Hex } from 'viem';
import { collectNotaryLogAnchors, EthersEasReader } from '@membership-card-protocol/verifier-rpc-provider';
import { ARBITRUM_RPC_URL } from '../support/liveCard.js';
import { rpcChain } from '../../../notary/host/src/chain/rpc.ts';
import { deployEas, schemaUid, type EasDeployment } from '../../../governance/scripts/notary-eas.ts';
// ethers is the verifier provider's dependency, not this package's
import { JsonRpcProvider } from '../../../membership_card_verifier/packages/verifier-rpc-provider/node_modules/ethers/lib.esm/index.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const artifacts = process.env['EAS_CONTRACTS_DIR'];
const enabled = !!artifacts && existsSync(join(artifacts, '@ethereum-attestation-service/eas-contracts/artifacts/contracts/EAS.sol/EAS.json'));
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64url');

function parseDevVars(path: string): Record<string, string> {
  return Object.fromEntries(readFileSync(path, 'utf-8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

describe.skipIf(!enabled)('notary host: EAS anchorer on the devnode', () => {
  let dep: EasDeployment;
  let client: ReturnType<typeof rpcChain>;
  let reader: EthersEasReader;
  const jobA = b64(randomBytes(32));
  const jobB = b64(randomBytes(32));
  const card = randomBytes(32).toString('hex');

  beforeAll(async () => {
    expect(/^https?:\/\/(localhost|127\.0\.0\.1|nitro-devnode)(:\d+)?/.test(ARBITRUM_RPC_URL), `refusing a non-local RPC URL: ${ARBITRUM_RPC_URL}`).toBe(true);
    const deployment = JSON.parse(readFileSync(join(REPO_ROOT, 'contracts/deployments/local.json'), 'utf-8')) as { contracts: { logic_contract: Hex; storage_contract: Hex } };
    const rawGas = parseDevVars(join(REPO_ROOT, 'integration_tests/env/press/.dev.vars')).PRESS_GAS_WALLET_PRIVATE_KEY!;
    const key = rawGas.startsWith('0x') ? rawGas : `0x${rawGas}`;
    dep = await deployEas({ rpc: ARBITRUM_RPC_URL, key, artifacts: artifacts! });
    client = rpcChain({ rpcUrl: ARBITRUM_RPC_URL, logicContract: deployment.contracts.logic_contract, storageContract: deployment.contracts.storage_contract, gasWalletKey: key, easContract: dep.eas, easSchemaUid: dep.schemaUid });
    reader = new EthersEasReader(new JsonRpcProvider(ARBITRUM_RPC_URL), dep.eas);
  }, 300_000);

  const anchors = (scope: string, schema?: string) =>
    collectNotaryLogAnchors(reader, scope, { schemaUid: schema ?? dep.schemaUid, fromBlock: dep.schemaBlock });
  /** Reads until `want(result)` holds (an RPC node can serve `eth_getLogs` a moment after the receipt); returns the last read and how many tries it took. */
  const eventually = async (scope: string, want: (r: Awaited<ReturnType<typeof anchors>>) => boolean) => {
    let r = await anchors(scope);
    for (let i = 1; !want(r) && i < 10; i++) { await new Promise((x) => setTimeout(x, 500)); r = await anchors(scope); lag = i; }
    return r;
  };
  let lag = 0; // the most retries any read needed; reported at the end so a lagging node is visible, not hidden

  it('the deployed schema UID is the one EAS computes for the notary schema', () => {
    expect(dep.schemaUid).toBe(schemaUid());
    expect(client.eas).toBeDefined();
  });

  it('refuses a non-local RPC URL (the deploy script is devnode only)', async () => {
    await expect(deployEas({ rpc: 'https://arb1.arbitrum.io/rpc', key: '0x' + '11'.repeat(32), artifacts: artifacts! })).rejects.toThrow(/non-local RPC/);
  });

  it('anchors a job-log record and the production reader reads it back', async () => {
    const cidA0 = `bafy-anchor-${randomBytes(3).toString('hex')}-0`;
    const r = await client.eas!.anchor({ scopeId: jobA, seq: 0, recordCid: cidA0 });
    expect(r.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    const got = await eventually(jobA, (r) => r.length >= 1);
    expect(got.map((a) => ({ seq: a.seq, record_cid: a.record_cid }))).toEqual([{ seq: 0, record_cid: cidA0 }]);
    expect(got[0]!.timestamp).toBeGreaterThan(1_700_000_000_000);
  }, 120_000);

  it('records come back in order, and one scope never sees another scope\'s records', async () => {
    const c1 = `bafy-anchor-${randomBytes(3).toString('hex')}-1`;
    const c2 = `bafy-anchor-${randomBytes(3).toString('hex')}-2`;
    const b0 = `bafy-anchor-${randomBytes(3).toString('hex')}-b0`;
    await client.eas!.anchor({ scopeId: jobA, seq: 1, recordCid: c1 });
    await client.eas!.anchor({ scopeId: jobB, seq: 0, recordCid: b0 });
    await client.eas!.anchor({ scopeId: jobA, seq: 2, recordCid: c2 });
    expect((await eventually(jobA, (r) => r.length >= 3)).map((a) => a.seq)).toEqual([0, 1, 2]);
    expect((await eventually(jobB, (r) => r.length >= 1)).map((a) => a.record_cid)).toEqual([b0]);
    expect(await anchors(b64(randomBytes(32)))).toEqual([]);
  }, 180_000);

  it('an identity log is anchored by notary card address (64 hex) and read the same way', async () => {
    const cid = `bafy-identity-${randomBytes(3).toString('hex')}`;
    await client.eas!.anchor({ scopeId: card, seq: 0, recordCid: cid });
    expect((await eventually(card, (r) => r.length > 0)).map((a) => a.record_cid)).toEqual([cid]);
    console.log(`identity read needed ${lag} retries`);
  }, 120_000);

  it('control: a different schema UID reads none of it', async () => {
    expect(await anchors(jobA, '0x' + '00'.repeat(31) + '01')).toEqual([]);
  });

  it('a scope that is neither a job hash nor a card address is refused before anything is sent', async () => {
    await expect(client.eas!.anchor({ scopeId: 'not-a-scope', seq: 0, recordCid: 'x' })).rejects.toThrow(/scope must be/);
  });
});
