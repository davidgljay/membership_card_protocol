/**
 * Core verification logic — §7 of the Chitt Protocol spec.
 *
 * Verification stages (executed per signature entry):
 *   1. Signature validity (offline, canonical CBOR + ML-DSA-44)
 *   2. Sub-chitt → master link (Arbitrum One)
 *   3. Chain walk — historical (IPFS, parallelized)
 *   4. Revocation check — current (Arbitrum One + IPFS log)
 *   5. Policy match (predicates, deferred — returns scope_clean: true placeholder)
 *   6. Recipient-set check
 *   7. Replay and freshness check (caller's responsibility for replay; freshness checked here)
 *
 * Returns per-signature SignatureResult objects and extracted links.
 */

import type {
  ChittDocument,
  ChittProvider,
  MessagePayload,
  PolicyChainLink,
  SignatureEntry,
  SignatureResult,
  ValidationChains,
} from './types.js';
import { canonicalize } from './serialization.js';
import { verifySignature } from './crypto.js';
import {
  type GoverningRevocation,
  findGoverningRevocation,
  wasValidAtSigningTime,
  isCurrentlyValid,
  revocationStatus,
} from './revocation.js';

export interface VerifySignatureOptions {
  provider: ChittProvider;
  trustedRoots: string[];
  verifierChitt?: string;
  freshnessWindowSeconds: number;
  payload: MessagePayload;
  signingTimeMs: number;
}

export interface VerifySignatureOutput {
  result: SignatureResult;
  /** policy_id CID extracted from the master chitt genesis (if resolved). */
  policyCid: string | null;
  /** press_chitt pointer extracted from the master chitt genesis (if resolved). */
  pressChittPointer: string | null;
  /** press_chitt pointer extracted from the policy chitt (if resolved). */
  policyCreatorPointer: string | null;
  /** On-chain registry address of the sender's master chitt (if resolved). */
  masterChittAddress: string | null;
}

/**
 * Verify a single signature entry from a signed message envelope.
 * Performs all §7 stages and returns the structured result plus extracted links.
 */
export async function verifySignatureEntry(
  entry: SignatureEntry,
  opts: VerifySignatureOptions,
): Promise<VerifySignatureOutput> {
  const nowMs = Date.now();
  const baseResult: SignatureResult = {
    signer_chitt: entry.signer_chitt,
    signature_valid: false,
    chain_reaches_trusted_root: false,
    scope_clean: true, // predicate evaluation deferred (§7 stage 5)
    revocation: { status: 'none', code: null, effective_date: null, data_freshness_seconds: 0 },
    was_valid_at_signing_time: false,
    is_currently_valid: false,
    addressed_to_verifier: false,
    annotations: [],
  };

  // -------------------------------------------------------------------------
  // Stage 7: Recipient-set check — computed first, always included in result.
  // -------------------------------------------------------------------------
  const addressedToVerifier =
    opts.verifierChitt !== undefined &&
    opts.payload.recipients.includes(opts.verifierChitt);

  // -------------------------------------------------------------------------
  // Stage 1: Signature validity
  // -------------------------------------------------------------------------
  const payloadBytes = canonicalize(opts.payload as unknown as Record<string, unknown>);
  const sigValid = verifySignature(entry.public_key, payloadBytes, entry.signature);

  if (!sigValid) {
    return {
      result: { ...baseResult, signature_valid: false, addressed_to_verifier: addressedToVerifier },
      policyCid: null,
      pressChittPointer: null,
      policyCreatorPointer: null,
      masterChittAddress: null,
    };
  }

  // -------------------------------------------------------------------------
  // Stage 2: Sub-chitt → master link
  // -------------------------------------------------------------------------
  let masterChittAddress: string | null = null;
  let policyCid: string | null = null;
  let pressChittPointer: string | null = null;
  let policyCreatorPointer: string | null = null;

  try {
    const registration = await opts.provider.getSubChittRegistration(entry.signer_chitt);
    if (!registration) {
      return {
        result: {
          ...baseResult,
          signature_valid: true,
          addressed_to_verifier: addressedToVerifier,
          error: 'Sub-chitt registration not found on-chain',
        },
        policyCid,
        pressChittPointer,
        policyCreatorPointer,
        masterChittAddress,
      };
    }
    masterChittAddress = registration.masterChittAddress;
  } catch (err) {
    return {
      result: {
        ...baseResult,
        signature_valid: true,
        addressed_to_verifier: addressedToVerifier,
        error: `Sub-chitt registration lookup failed: ${String(err)}`,
      },
      policyCid,
      pressChittPointer,
      policyCreatorPointer,
      masterChittAddress,
    };
  }

  // -------------------------------------------------------------------------
  // Stages 3+4: Chain walk and revocation check via IPFS log traversal.
  // getAllLogEntries walks the full log in one pass, giving us both the
  // complete entry history (for revocation checks) and the genesis doc
  // (for press_chitt / policy_id links). This avoids a second log fetch.
  // -------------------------------------------------------------------------
  let chainReachesTrustedRoot = false;
  let revResult: { status: 'none' | 'revoked'; code: number | null; effective_date: string | null; data_freshness_seconds: number } = {
    status: 'none',
    code: null,
    effective_date: null,
    data_freshness_seconds: 0,
  };
  let wasValidAtSigning = true;
  let currentlyValid = true;

  try {
    const masterLogHeadCid = await opts.provider.getLogHead(masterChittAddress!);
    if (!masterLogHeadCid) {
      return {
        result: {
          ...baseResult,
          signature_valid: true,
          addressed_to_verifier: addressedToVerifier,
          error: 'Master chitt log head not found on-chain',
        },
        policyCid,
        pressChittPointer,
        policyCreatorPointer,
        masterChittAddress,
      };
    }

    const { entries: allEntries, genesis, fetchedAt } = await opts.provider.getAllLogEntries(
      masterChittAddress!,
      masterLogHeadCid,
    );

    // Extract policy links from the genesis doc (original ChittDocument at log root).
    policyCid = genesis?.policy_id ?? null;
    pressChittPointer = genesis?.press_chitt ?? null;

    // Chain trust check: master address itself, or walk press_chitt ancestors.
    chainReachesTrustedRoot = opts.trustedRoots.includes(masterChittAddress!);
    if (!chainReachesTrustedRoot && pressChittPointer) {
      chainReachesTrustedRoot = await walkChainForTrustedRoot(
        pressChittPointer,
        opts.provider,
        opts.trustedRoots,
      );
    }

    // Fetch policy chitt to extract the policyCreator pointer.
    if (policyCid) {
      try {
        const policyChitt = (await opts.provider.fetchIPFS(policyCid)) as ChittDocument;
        policyCreatorPointer = policyChitt.press_chitt ?? null;
      } catch {
        // Non-fatal: policy chitt may not be pinned.
      }
    }

    // Stage 4: Revocation — reuse entries already fetched above.
    const logEntries = allEntries.map(e => e.entry);
    const governing = findGoverningRevocation(logEntries);
    revResult = revocationStatus(governing, fetchedAt);

    if (revResult.data_freshness_seconds > opts.freshnessWindowSeconds) {
      currentlyValid = false;
    } else {
      wasValidAtSigning = wasValidAtSigningTime(governing, opts.signingTimeMs);
      currentlyValid = isCurrentlyValid(governing, nowMs);
    }
  } catch (err) {
    return {
      result: {
        ...baseResult,
        signature_valid: true,
        addressed_to_verifier: addressedToVerifier,
        error: `Chain walk failed: ${String(err)}`,
      },
      policyCid,
      pressChittPointer,
      policyCreatorPointer,
      masterChittAddress,
    };
  }

  return {
    result: {
      signer_chitt: entry.signer_chitt,
      signature_valid: true,
      chain_reaches_trusted_root: chainReachesTrustedRoot,
      scope_clean: true,
      revocation: revResult,
      was_valid_at_signing_time: wasValidAtSigning,
      is_currently_valid: currentlyValid,
      addressed_to_verifier: addressedToVerifier,
      annotations: [],
    },
    policyCid,
    pressChittPointer,
    policyCreatorPointer,
    masterChittAddress,
  };
}

/**
 * Walk the press_chitt authorization chain upward from startAddress,
 * collecting all log entries and their CIDs for each chitt encountered.
 *
 * Each link in the returned array represents one chitt in the chain, with
 * its full update history (newest-first) and a pointer to its log head.
 * The chain proceeds upward via each genesis doc's press_chitt field.
 */
export async function walkPolicyCreationChain(
  startAddress: string,
  provider: ChittProvider,
  maxDepth = 50,
): Promise<PolicyChainLink[]> {
  const chain: PolicyChainLink[] = [];
  let currentAddress: string | null = startAddress;

  for (let depth = 0; depth < maxDepth && currentAddress !== null; depth++) {
    let logHeadUrl: string | null = null;
    let nextAddress: string | null = null;
    const updates: PolicyChainLink['updates'] = [];

    try {
      const logHeadCid = await provider.getLogHead(currentAddress);
      if (logHeadCid) {
        logHeadUrl = `ipfs://${logHeadCid}`;
        const { entries, genesis } = await provider.getAllLogEntries(currentAddress, logHeadCid);
        for (const { entry, cid } of entries) {
          updates.push({
            version: entry.version,
            entryType: entry.entry_type,
            // code is at the top level of every LogEntry; null only for field_update entries
            // where the caller wants a revocation-specific status code.
            statusCode: entry.entry_type === 'revocation' ? entry.code : null,
            cid: `ipfs://${cid}`,
          });
        }
        nextAddress = genesis?.press_chitt ?? null;
      }
    } catch {
      // Stop chain walk on error, but still include the partial link.
    }

    chain.push({ chittAddress: currentAddress, logHeadUrl, updates });
    currentAddress = nextAddress;
  }

  return chain;
}

/**
 * Walk the press_chitt chain to check if any ancestor reaches a trusted root.
 */
async function walkChainForTrustedRoot(
  address: string,
  provider: ChittProvider,
  trustedRoots: string[],
  depth = 0,
): Promise<boolean> {
  if (depth > 20) return false;
  if (trustedRoots.includes(address)) return true;

  try {
    const logHeadCid = await provider.getLogHead(address);
    if (!logHeadCid) return false;
    const { genesis } = await provider.getAllLogEntries(address, logHeadCid);
    if (!genesis?.press_chitt) return false;
    return walkChainForTrustedRoot(genesis.press_chitt, provider, trustedRoots, depth + 1);
  } catch {
    return false;
  }
}

/**
 * Walk three policy creation chains in parallel and return a ValidationChains object.
 * Returns null if all three starting addresses are null.
 */
export async function resolveValidationChains(
  masterChittAddress: string | null,
  pressChittPointer: string | null,
  policyCreatorPointer: string | null,
  provider: ChittProvider,
): Promise<ValidationChains | null> {
  if (!masterChittAddress && !pressChittPointer && !policyCreatorPointer) {
    return null;
  }

  const [chitt, chittAuthorizer, policyCreator] = await Promise.all([
    masterChittAddress
      ? walkPolicyCreationChain(masterChittAddress, provider)
      : Promise.resolve([]),
    pressChittPointer
      ? walkPolicyCreationChain(pressChittPointer, provider)
      : Promise.resolve([]),
    policyCreatorPointer
      ? walkPolicyCreationChain(policyCreatorPointer, provider)
      : Promise.resolve([]),
  ]);

  return { chitt, chittAuthorizer, policyCreator };
}

/**
 * Resolve a mutable pointer (on-chain registry address) to an ipfs:// URL
 * by looking up the current log head CID.
 */
export async function resolvePointerToIpfsUrl(
  pointer: string,
  provider: ChittProvider,
): Promise<string | null> {
  try {
    const cid = await provider.getLogHead(pointer);
    if (!cid) return null;
    return `ipfs://${cid}`;
  } catch {
    return null;
  }
}
