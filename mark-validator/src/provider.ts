/**
 * ChittProvider implementations.
 *
 * The default HttpChittProvider uses a public IPFS gateway for content fetches
 * and a JSON-RPC endpoint for Arbitrum One reads. The registry contract is not
 * yet deployed; getLogHead and getSubChittRegistration will throw until the
 * contract address is configured and the ABI is finalized.
 */

import type { ChittDocument, ChittProvider, LogEntry, LogEntryWithCid, SubChittRegistration } from './types.js';

const DEFAULT_IPFS_GATEWAY = 'https://ipfs.io';
const DEFAULT_ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc';

export interface HttpChittProviderOptions {
  ipfsGateway?: string;
  arbitrumRpcUrl?: string;
  /** Address of the deployed Chitt registry contract on Arbitrum One. */
  registryContractAddress?: string;
}

/**
 * Default provider that fetches IPFS content via an HTTP gateway and reads
 * Arbitrum One state via JSON-RPC.
 *
 * On-chain reads require the Chitt registry contract to be deployed and its
 * address provided in options. Until then, getLogHead and getSubChittRegistration
 * throw a clear error explaining what's needed.
 */
export class HttpChittProvider implements ChittProvider {
  private readonly ipfsGateway: string;
  private readonly arbitrumRpcUrl: string;
  private readonly registryContractAddress: string | undefined;

  constructor(options: HttpChittProviderOptions = {}) {
    this.ipfsGateway = options.ipfsGateway ?? DEFAULT_IPFS_GATEWAY;
    this.arbitrumRpcUrl = options.arbitrumRpcUrl ?? DEFAULT_ARBITRUM_RPC;
    this.registryContractAddress = options.registryContractAddress;
  }

  /**
   * Fetch a JSON document from IPFS by its CID.
   * CID is a base64url string as it appears in chitt fields; it is re-encoded
   * as a standard multibase CID string for the gateway URL.
   */
  async fetchIPFS(cid: string): Promise<unknown> {
    const url = `${this.ipfsGateway}/ipfs/${cidToGatewayPath(cid)}`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`IPFS fetch failed for CID ${cid}: HTTP ${response.status}`);
    }
    return response.json() as Promise<unknown>;
  }

  /**
   * Read the current log head CID for a registry address from Arbitrum One.
   *
   * Requires the registry contract to be deployed. Calls `getLogHead(bytes32)`
   * on the registry contract and decodes the returned CID bytes.
   */
  async getLogHead(registryAddress: string): Promise<string | null> {
    if (!this.registryContractAddress) {
      throw new Error(
        'Chitt registry contract not deployed yet. ' +
          'Provide registryContractAddress in ValidationOptions once the contract is live.',
      );
    }
    // eth_call to registry contract: getLogHead(bytes32 registryAddress) returns (bytes memory cid)
    const callData = encodeGetLogHead(registryAddress);
    const result = await ethCall(
      this.arbitrumRpcUrl,
      this.registryContractAddress,
      callData,
    );
    return decodeLogHeadResult(result);
  }

  /**
   * Look up a sub-chitt's master registration from Arbitrum One.
   *
   * Calls `getSubChittMaster(bytes32 subChittAddress)` on the registry contract.
   */
  async getSubChittRegistration(
    subChittAddress: string,
  ): Promise<SubChittRegistration | null> {
    if (!this.registryContractAddress) {
      throw new Error(
        'Chitt registry contract not deployed yet. ' +
          'Provide registryContractAddress in ValidationOptions once the contract is live.',
      );
    }
    const callData = encodeGetSubChittMaster(subChittAddress);
    const result = await ethCall(
      this.arbitrumRpcUrl,
      this.registryContractAddress,
      callData,
    );
    return decodeSubChittMasterResult(result);
  }

  /**
   * Walk the IPFS log from logHeadCid backward through prev_log_root links,
   * returning ALL log entries with their CIDs plus the genesis ChittDocument.
   *
   * Entries are returned newest-first (head → genesis direction).
   * The genesis document is identified by the absence of an entry_type field.
   */
  async getAllLogEntries(
    _registryAddress: string,
    logHeadCid: string,
  ): Promise<{ entries: LogEntryWithCid[]; genesis: ChittDocument | null; fetchedAt: Date }> {
    const entries: LogEntryWithCid[] = [];
    let genesis: ChittDocument | null = null;
    let currentCid: string | null = logHeadCid;
    const fetchedAt = new Date();

    while (currentCid !== null) {
      const doc = (await this.fetchIPFS(currentCid)) as Record<string, unknown>;
      if ('entry_type' in doc) {
        entries.push({ entry: doc as unknown as LogEntry, cid: currentCid });
        currentCid = (doc.prev_log_root as string | undefined | null) ?? null;
      } else {
        genesis = doc as unknown as ChittDocument;
        break;
      }
    }

    return { entries, genesis, fetchedAt };
  }
}

// ---------------------------------------------------------------------------
// CID encoding helpers
// ---------------------------------------------------------------------------

/**
 * Convert a base64url CID (as stored in chitt fields) to the multibase string
 * used in IPFS gateway URLs.
 *
 * Chitt fields store CIDs as base64url-encoded raw bytes (the CID byte string).
 * IPFS gateways accept CIDv1 in base32 (bafy...) or CIDv0 (Qm...) encoding.
 *
 * If the CID bytes begin with 0x12 0x20 (CIDv0 / sha2-256 / 32 bytes),
 * they are re-encoded as a base58btc CIDv0 string (Qm...). Otherwise the
 * base64url string is returned as-is and the gateway is expected to handle it.
 */
function cidToGatewayPath(cid: string): string {
  // If it already looks like a CID string (starts with Qm or bafy), return as-is
  if (/^(Qm[a-zA-Z0-9]+|b[a-z2-7]+)$/.test(cid)) return cid;
  // Otherwise treat as base64url-encoded CID bytes and return the raw string.
  // Most modern IPFS gateways accept base64url CIDs with a 'u' multibase prefix.
  return `u${cid}`;
}

// ---------------------------------------------------------------------------
// Minimal ABI encoding for registry contract calls
//
// The full ABI is not yet finalized (contract not deployed). These functions
// encode the two read calls we need. Update when the ABI is locked.
// ---------------------------------------------------------------------------

/** keccak256("getLogHead(bytes32)") first 4 bytes: selector */
const GET_LOG_HEAD_SELECTOR = '0x1234abcd'; // placeholder — update when ABI is finalized

/** keccak256("getSubChittMaster(bytes32)") first 4 bytes: selector */
const GET_SUB_CHITT_MASTER_SELECTOR = '0x5678efgh'; // placeholder — update when ABI is finalized

function encodeGetLogHead(registryAddress: string): string {
  const addr = padBytes32(registryAddress);
  return GET_LOG_HEAD_SELECTOR + addr;
}

function encodeGetSubChittMaster(subChittAddress: string): string {
  const addr = padBytes32(subChittAddress);
  return GET_SUB_CHITT_MASTER_SELECTOR + addr;
}

function padBytes32(hexOrBase64url: string): string {
  // Remove 0x prefix if present, left-pad to 64 hex chars
  const hex = hexOrBase64url.startsWith('0x')
    ? hexOrBase64url.slice(2)
    : Buffer.from(hexOrBase64url, 'base64url').toString('hex');
  return hex.padStart(64, '0');
}

function decodeLogHeadResult(result: string): string | null {
  // ABI-decode bytes return value: offset (32 bytes) + length (32 bytes) + data
  if (!result || result === '0x') return null;
  const hex = result.startsWith('0x') ? result.slice(2) : result;
  if (hex.length < 128) return null;
  const lengthHex = hex.slice(64, 128);
  const length = parseInt(lengthHex, 16);
  if (length === 0) return null;
  const dataHex = hex.slice(128, 128 + length * 2);
  // Return as base64url
  const bytes = Uint8Array.from(
    dataHex.match(/.{2}/g)!.map(b => parseInt(b, 16)),
  );
  return Buffer.from(bytes).toString('base64url');
}

function decodeSubChittMasterResult(result: string): SubChittRegistration | null {
  // ABI-decode (bytes32 masterAddress, bytes32 registrationLogHeadCid)
  if (!result || result === '0x') return null;
  const hex = result.startsWith('0x') ? result.slice(2) : result;
  if (hex.length < 128) return null;
  const masterHex = hex.slice(0, 64);
  const logHeadHex = hex.slice(64, 128);
  const masterBytes = Uint8Array.from(
    masterHex.match(/.{2}/g)!.map(b => parseInt(b, 16)),
  );
  const logHeadBytes = Uint8Array.from(
    logHeadHex.match(/.{2}/g)!.map(b => parseInt(b, 16)),
  );
  return {
    masterChittAddress: Buffer.from(masterBytes).toString('base64url'),
    registrationLogHeadCid: Buffer.from(logHeadBytes).toString('base64url'),
  };
}

// ---------------------------------------------------------------------------
// Minimal JSON-RPC eth_call
// ---------------------------------------------------------------------------

async function ethCall(rpcUrl: string, to: string, data: string): Promise<string> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_call',
      params: [{ to, data }, 'latest'],
      id: 1,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Arbitrum RPC error: HTTP ${response.status}`);
  }
  const json = (await response.json()) as { result?: string; error?: { message: string } };
  if (json.error) throw new Error(`Arbitrum RPC error: ${json.error.message}`);
  return json.result ?? '0x';
}
