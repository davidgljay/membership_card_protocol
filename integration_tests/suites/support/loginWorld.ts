/**
 * Builds a card-login world on the live local stack (plans/card-login-code-plan.md
 * §1 "Test fixtures", step 4.4), using the real SDK functions end to end:
 *
 *   login-app-root (trusted root; also the app-certification root and the
 *   │               app card for the user's device sub-card)
 *   ├── login-service-branch (fixed address = PRESS_LOGIN_SERVICE_CERTIFICATION_ROOT)
 *   │    └── login service card ── code 520 domain_binding (signed by the admin card)
 *   │         └── server card (S1; registered + code 510 on the login service card)
 *   ├── DNS admin card for <run>.example.org (RegisterDomain on chain)
 *   └── user card ── device sub-card (code 510 on the user card)
 *
 * The two fixed nodes are minted once per stack and reused; everything else
 * is new per call, so suites can build several worlds.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createPublicClient, http, type Hex } from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import {
  deriveKeypair,
  mintCard,
  mintChildCard,
  ensureDnsGovernancePolicy,
  registerDomain,
  InMemorySecureKeyProvider,
  type GovernanceKeypair,
} from '@membership-card-protocol/integration-fixtures';
import {
  keccak256,
  bytesToBase64Url,
  base64UrlToBytes,
  mlDsa44Sign,
  requestSubCard,
  createServerCardRequest,
  createPressSubCardRegistrar,
  type ObliviousProtocolTransport,
  type SecureKeyProvider,
  type SignedSubCardDocument,
} from '@membership-card-protocol/app-sdk';
import { createDevSecureKeyProvider } from '@membership-card-protocol/app-sdk/testing';
import {
  authorizeServerCard,
  signDomainBindingAttestation,
  postDomainBinding,
  postSubCardAddedToDirectory,
} from '@membership-card-protocol/wallet-sdk';
import { CardVerifier, readCardFields } from '@membership-card-protocol/verifier';
import { EthersRpcProvider } from '@membership-card-protocol/verifier-rpc-provider';
import { FilebaseIpfsProvider } from '@membership-card-protocol/verifier-ipfs-provider';
import { ensureLiveGovernance, PRESS_BASE_URL, ARBITRUM_RPC_URL } from './liveCard.js';
import { createRegistryContract } from './registryContract.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
export const APP_ROOT_LABEL = 'login-app-root';
export const LOGIN_BRANCH_LABEL = 'login-service-branch';

function devVars(): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of readFileSync(join(REPO_ROOT, 'integration_tests/env/press/.dev.vars'), 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    vars[t.slice(0, t.indexOf('='))] = t.slice(t.indexOf('=') + 1);
  }
  return vars;
}

/** A direct-HTTP transport for tests (the RequestOptions `bypass` path). */
export const directTransport: ObliviousProtocolTransport = {
  async request(destination, options) {
    if (destination.kind !== 'press') throw new Error('directTransport: press only');
    const res = await fetch(destination.baseUrl.replace(/\/$/, '') + options.path, {
      method: options.method,
      headers: options.headers,
      ...(options.body ? { body: options.body as unknown as ArrayBuffer } : {}),
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return { status: res.status, headers, body: new Uint8Array(await res.arrayBuffer()) };
  },
};

export interface Identity {
  address: string;
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  pubkey: string;
}
const identity = (label: string): Identity => {
  const k = deriveKeypair(`holder:${label}`);
  return { address: keccak256(k.publicKey), publicKey: k.publicKey, secretKey: k.secretKey, pubkey: bytesToBase64Url(k.publicKey) };
};

async function adminPost(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${PRESS_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${devVars().PRESS_ADMIN_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}: ${await res.text()}`);
}

export interface LoginWorld {
  verifier: CardVerifier;
  chain: { rpc: EthersRpcProvider; ipfs: FilebaseIpfsProvider };
  policyId: string;
  /** keccak256(policyId) — the on-chain policy address of every card here. */
  policyAddress: string;
  domain: string;
  origin: string;
  appRoot: Identity;
  loginBranch: Identity;
  service: Identity;
  admin: Identity;
  user: Identity;
  server: { pointer: string; pubkey: string; keyId: string; keyProvider: SecureKeyProvider };
  device: { pointer: string; publicKey: Uint8Array; sign: (m: Uint8Array) => Promise<Uint8Array> };
}

async function ensureCard(rpc: EthersRpcProvider, label: string, mint: () => Promise<unknown>): Promise<Identity> {
  const id = identity(label);
  const entry = await rpc.getCardEntry(id.address);
  if (!entry) await mint();
  return id;
}

export async function buildLoginWorld(options: { run?: string } = {}): Promise<LoginWorld> {
  const run = options.run ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const gov = await ensureLiveGovernance();
  const deployment = JSON.parse(readFileSync(join(REPO_ROOT, 'contracts/deployments/local.json'), 'utf-8')) as {
    contracts: { logic_contract: string; storage_contract: string };
    dev_governance_keypair: GovernanceKeypair;
  };
  const logic = deployment.contracts.logic_contract as Hex;
  const storage = deployment.contracts.storage_contract as Hex;
  const client = createPublicClient({ chain: arbitrumSepolia, transport: http(ARBITRUM_RPC_URL) });
  const rpc = new EthersRpcProvider(createRegistryContract(client, storage, logic));
  const ipfs = new FilebaseIpfsProvider({ gatewayUrl: 'http://localhost:8080/ipfs' });
  const mintUnder = (issuerLabel: string, label: string, fieldValues: Record<string, unknown>) =>
    mintChildCard({ pressBaseUrl: PRESS_BASE_URL, policyId: gov.policyId, issuerHolderLabel: `holder:${issuerLabel}`, label, fieldValues });

  // Fixed nodes: the app-certification root and the login service branch.
  const appRoot = await ensureCard(rpc, APP_ROOT_LABEL, () => mintCard({ pressBaseUrl: PRESS_BASE_URL, policyId: gov.policyId, label: APP_ROOT_LABEL, fieldValues: { display_name: 'Login App Root' } }));
  await adminPost('/api/admin/trusted-roots', { address: appRoot.address });
  const loginBranch = await ensureCard(rpc, LOGIN_BRANCH_LABEL, () => mintUnder(APP_ROOT_LABEL, LOGIN_BRANCH_LABEL, { display_name: 'Login Service Branch' }));

  // Per-world cards.
  const serviceLabel = `login-service-${run}`;
  const adminLabel = `dns-admin-${run}`;
  const userLabel = `login-user-${run}`;
  await mintUnder(LOGIN_BRANCH_LABEL, serviceLabel, { display_name: `Login Service ${run}` });
  await mintUnder(APP_ROOT_LABEL, adminLabel, { display_name: `DNS Admin ${run}` });
  await mintUnder(APP_ROOT_LABEL, userLabel, { display_name: `Member ${run}` });
  const service = identity(serviceLabel);
  const admin = identity(adminLabel);
  const user = identity(userLabel);

  // DNS: register <run>.example.org with the admin card (dns_resolution.md §6.1).
  const domain = `${run}.example.org`;
  const dns = { rpcUrl: ARBITRUM_RPC_URL, logicAddress: logic, storageAddress: storage, governanceKeypair: deployment.dev_governance_keypair, contractsScriptsDir: join(REPO_ROOT, 'contracts/scripts') };
  await ensureDnsGovernancePolicy({ ...dns, policyAddress: gov.policyAddress });
  await registerDomain({ ...dns, domain, adminCardAddress: admin.address });

  // Gas for sub-card registrations (paid by the app card's account).
  for (const a of [service.address, appRoot.address]) {
    await adminPost('/api/admin/app-gas-credit', { app_card_address: a, wei_amount: String(10n ** 18n) });
  }

  // Domain binding: admin signs, login service card posts code 520.
  const binding = signDomainBindingAttestation({ domain, adminCardSecretKey: admin.secretKey, adminCardPublicKey: admin.pubkey, loginServiceCardPublicKey: service.pubkey });
  await postDomainBinding({ transport: directTransport, pressBaseUrl: PRESS_BASE_URL, binding, loginServiceCardSecretKey: service.secretKey, loginServiceCardPublicKey: service.pubkey });

  const addToDirectory = (card: Identity) => async (newPubkey: string) => {
    const current = (await readCardFields(card.pubkey, { rpc, ipfs }))?.fields['active_subcards'] as string[] | undefined;
    return postSubCardAddedToDirectory({
      transport: directTransport,
      pressBaseUrl: PRESS_BASE_URL,
      masterCardPointer: card.address,
      masterSecretKey: card.secretKey,
      masterPublicKey: card.pubkey,
      currentActiveSubcards: current ?? null,
      newSubCardPublicKey: newPubkey,
    });
  };
  const registrar = createPressSubCardRegistrar({ transport: directTransport, pressBaseUrl: PRESS_BASE_URL });

  // Server card (subcards.md §Server Cards).
  const keyProvider = createDevSecureKeyProvider();
  const { unsignedDocument, server } = await createServerCardRequest({ loginServiceCard: service.address, loginServiceCardPubkey: service.pubkey, keyProvider, keyId: `server-${run}` });
  const authorized = await authorizeServerCard({ unsignedDocument, loginServiceCardSecretKey: service.secretKey, registerSubCard: registrar, postActiveSubcardAddition: addToDirectory(service) });
  if (!authorized.registered) throw new Error(`buildLoginWorld: server card not registered: ${authorized.code}: ${authorized.reason}`);

  // The user's device sub-card, certified by the app root (wallet self-signing shape).
  const appKeys = new InMemorySecureKeyProvider();
  await appKeys.generateKey(`holder:${APP_ROOT_LABEL}`);
  const deviceKeys = createDevSecureKeyProvider();
  const req = await requestSubCard({
    secureKeyProvider: deviceKeys,
    subCardKeyId: `device-${run}`,
    appCard: { cardPointer: appRoot.address, publicKey: appRoot.publicKey, sign: (m) => appKeys.sign(`holder:${APP_ROOT_LABEL}`, m) },
    holderPrimaryCard: user.address,
    holderPrimaryCardPubkey: user.publicKey,
    capabilities: ['auth_response', 'error'],
    attestationLevel: 'T1',
  });
  const appSigned = req.document as unknown as Record<string, unknown>;
  const { canonicalize } = await import('@membership-card-protocol/app-sdk');
  const holderSignature = bytesToBase64Url(mlDsa44Sign(user.secretKey, canonicalize(appSigned)));
  const signedDevice = { ...appSigned, holder_signature: holderSignature } as unknown as SignedSubCardDocument;
  {
    const { holder_signature, ...sub_card_document } = signedDevice as unknown as Record<string, unknown>;
    const res = await fetch(`${PRESS_BASE_URL}/api/sub-card/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sub_card_document, holder_signature }),
    });
    if (!res.ok) throw new Error(`buildLoginWorld: device sub-card not registered: HTTP ${res.status}: ${await res.text()}`);
  }
  await addToDirectory(user)(signedDevice.recipient_pubkey);
  const devicePk = base64UrlToBytes(signedDevice.recipient_pubkey);

  const verifier = new CardVerifier({
    rpc,
    ipfs,
    trustedRoots: [appRoot.address],
    appCertificationRoot: appRoot.address,
    loginServiceCertificationRoot: loginBranch.address,
    fetchAnnotations: false,
  });
  return {
    verifier,
    chain: { rpc, ipfs },
    policyId: gov.policyId,
    policyAddress: gov.policyAddress.replace(/^0x/, ''),
    domain,
    origin: `https://login.${domain}`,
    appRoot,
    loginBranch,
    service,
    admin,
    user,
    server: { ...server, keyProvider },
    device: { pointer: keccak256(devicePk), publicKey: devicePk, sign: (m) => deviceKeys.sign(`device-${run}`, m) },
  };
}
