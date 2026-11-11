/**
 * A CardVerifier and chain context for the dev environment (Sepolia + the
 * dev IPFS gateway), for the card login suite. Uses the shared registry
 * adapter (support/registryContract.ts, copied from integration_tests).
 */
import { createPublicClient, http, type Hex } from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import { CardVerifier } from '@membership-card-protocol/verifier';
import { EthersRpcProvider } from '@membership-card-protocol/verifier-rpc-provider';
import { FilebaseIpfsProvider } from '@membership-card-protocol/verifier-ipfs-provider';
import { ARBITRUM_RPC_URL, REGISTRY_CONTRACT_ADDRESS, LOGIC_CONTRACT_ADDRESS, IPFS_GATEWAY_URL } from './liveCard.js';
import { createRegistryContract } from './registryContract.js';

export function devChain() {
  const client = createPublicClient({ chain: arbitrumSepolia, transport: http(ARBITRUM_RPC_URL) });
  const rpc = new EthersRpcProvider(createRegistryContract(client as never, REGISTRY_CONTRACT_ADDRESS as Hex, LOGIC_CONTRACT_ADDRESS as Hex));
  const ipfs = new FilebaseIpfsProvider({ gatewayUrl: `${IPFS_GATEWAY_URL.replace(/\/$/, '')}/ipfs` });
  return { rpc, ipfs };
}

export async function createDevVerifier(roots: { appCertificationRoot: string; loginServiceCertificationRoot: string }): Promise<CardVerifier> {
  const { rpc, ipfs } = devChain();
  return new CardVerifier({ rpc, ipfs, trustedRoots: [roots.appCertificationRoot], ...roots, fetchAnnotations: false } as ConstructorParameters<typeof CardVerifier>[0]);
}
