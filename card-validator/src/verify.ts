/**
 * Core verification logic — §7 of the Card Protocol spec.
 *
 * Verification stages (executed per signature entry):
 *   1. Signature validity (offline, canonical CBOR + ML-DSA-44)
 *   2. Sub-card → master link (Arbitrum One)
 *   3. Chain walk — historical (IPFS, parallelized)
 *   4. Revocation check — current (Arbitrum One + IPFS log)
 *   5. Policy match (predicates, deferred — returns scope_clean: true placeholder)
 *   6. Recipient-set check
 *   7. Replay and freshness check (caller's responsibility for replay; freshness checked here)
 *
 * Returns per-signature SignatureResult objects and extracted links.
 */

import type {
  CardDocument,
  CardProvider,
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
  provider: CardProvider;
  trustedRoots: string[];
  verifierCard?: string;
  freshnessWindowSeconds: number;
  payload: MessagePayload;
  signingTimeMs: number;
}

export interface VerifySignatureOutput {
  result: SignatureResult;
  /** policy_id CID extracted from the master card genesis (if resolved). */
  policyCid: string | null;
  /** press_card pointer extracted from the master card genesis (if resolved). */
  pressCardPointer: string | null;
  /** press_card pointer extracted from the policy card (if resolved). */
  policyCreatorPointer: string | null;
  /** On-chain registry address of the sender's master card (if resolved). */
  masterCardAddress: string | null;
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
    signer_card: entry.signer_card,
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
    opts.verifierCard !== undefined &&
    opts.payload.recipients.includes(opts.verifierCard);

  // -------------------------------------------------------------------------
  // Stage 1: Signature validity
  // -------------------------------------------------------------------------
  const payloadBytes = canonicalize(opts.payload as unknown as Record<string, unknown>);
  const sigValid = verifySignature(entry.public_key, payloadBytes, entry.signature);

  if (!sigValid) {
    return {
      result: { ...baseResult, signature_valid: false, addressed_to_verifier: addressedToVerifier },
      policyCid: null,
      pressCardPointer: null,
      policyCreatorPointer: null,
      masterCardAddress: null,
    };
  }

  // -------------------------------------------------------------------------
  // Stage 2: Sub-card → master link
  // -------------------------------------------------------------------------
  let masterCardAddress: string | null = null;
  let policyCid: string | null = null;
  let pressCardPointer: string | null = null;
  let policyCreatorPointer: string | null = null;

  try {
    const registration = await opts.provider.getSubCardRegistration(entry.signer_card);
    if (!registration) {
      return {
        result: {
          ...baseResult,
          signature_valid: true,
          addressed_to_verifier: addressedToVerifier,
          error: 'Sub-card registration not found on-chain',
        },
        policyCid,
        pressCardPointer,
        policyCreatorPointer,
        masterCardAddress,
      };
    }
    masterCardAddress = registration.masterCardAddress;
  } catch (err) {
    return {
      result: {
        ...baseResult,
        signature_valid: true,
        addressed_to_verifier: addressedToVerifier,
        error: `Sub-card registration lookup failed: ${String(err)}`,
      },
      policyCid,
      pressCardPointer,
      policyCreatorPointer,
      masterCardAddress,
    };
  }

  // -------------------------------------------------------------------------
  // Stages 3+4: Chain walk and revocation check via IPFS log traversal.
  // getAllLogEntries walks the full log in one pass, giving us both the
  // complete entry history (for revocation checks) and the genesis doc
  // (for press_card / policy_id links). This avoids a second log fetch.
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
    const masterLogHeadCid = await opts.provider.getLogHead(masterCardAddress!);
    if (!masterLogHeadCid) {
      return {
        result: {
          ...baseResult,
          signature_valid: true,
          addressed_to_verifier: addressedToVerifier,
          error: 'Master card log head not found on-chain',
        },
        policyCid,
        pressCardPointer,
        policyCreatorPointer,
        masterCardAddress,
      };
    }

    const { entries: allEntries, genesis, fetchedAt } = await opts.provider.getAllLogEntries(
      masterCardAddress!,
      masterLogHeadCid,
    );

    // Extract policy links from the genesis doc (original CardDocument at log root).
    policyCid = genesis?.policy_id ?? null;
    pressCardPointer = genesis?.press_card ?? null;

    // Chain trust check: master address itself, or walk press_card ancestors.
    chainReachesTrustedRoot = opts.trustedRoots.includes(masterCardAddress!);
    if (!chainReachesTrustedRoot && pressCardPointer) {
      chainReachesTrustedRoot = await walkChainForTrustedRoot(
        pressCardPointer,
        opts.provider,
        opts.trustedRoots,
      );
    }

    // Fetch policy card to extract the policyCreator pointer.
    if (policyCid) {
      try {
        const policyCard = (await opts.provider.fetchIPFS(policyCid)) as CardDocument;
        policyCreatorPointer = policyCard.press_card ?? null;
      } catch {
        // Non-fatal: policy card may not be pinned.
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
      pressCardPointer,
      policyCreatorPointer,
      masterCardAddress,
    };
  }

  return {
    result: {
      signer_card: entry.signer_card,
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
    pressCardPointer,
    policyCreatorPointer,
    masterCardAddress,
  };
}

/**
 * Walk the press_card authorization chain upward from startAddress,
 * collecting all log entries and their CIDs for each card encountered.
 *
 * Each link in the returned array represents one card in the chain, with
 * its full update history (newest-first) and a pointer to its log head.
 * The chain proceeds upward via each genesis doc's press_card field.
 */
export async function walkPolicyCreationChain(
  startAddress: string,
  provider: CardProvider,
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
        nextAddress = genesis?.press_card ?? null;
      }
    } catch {
      // Stop chain walk on error, but still include the partial link.
    }

    chain.push({ cardAddress: currentAddress, logHeadUrl, updates });
    currentAddress = nextAddress;
  }

  return chain;
}

/**
 * Walk the press_card chain to check if any ancestor reaches a trusted root.
 */
async function walkChainForTrustedRoot(
  address: string,
  provider: CardProvider,
  trustedRoots: string[],
  depth = 0,
): Promise<boolean> {
  if (depth > 20) return false;
  if (trustedRoots.includes(address)) return true;

  try {
    const logHeadCid = await provider.getLogHead(address);
    if (!logHeadCid) return false;
    const { genesis } = await provider.getAllLogEntries(address, logHeadCid);
    if (!genesis?.press_card) return false;
    return walkChainForTrustedRoot(genesis.press_card, provider, trustedRoots, depth + 1);
  } catch {
    return false;
  }
}

/**
 * Walk three policy creation chains in parallel and return a ValidationChains object.
 * Returns null if all three starting addresses are null.
 */
export async function resolveValidationChains(
  masterCardAddress: string | null,
  pressCardPointer: string | null,
  policyCreatorPointer: string | null,
  provider: CardProvider,
): Promise<ValidationChains | null> {
  if (!masterCardAddress && !pressCardPointer && !policyCreatorPointer) {
    return null;
  }

  const [card, cardAuthorizer, policyCreator] = await Promise.all([
    masterCardAddress
      ? walkPolicyCreationChain(masterCardAddress, provider)
      : Promise.resolve([]),
    pressCardPointer
      ? walkPolicyCreationChain(pressCardPointer, provider)
      : Promise.resolve([]),
    policyCreatorPointer
      ? walkPolicyCreationChain(policyCreatorPointer, provider)
      : Promise.resolve([]),
  ]);

  return { card, cardAuthorizer, policyCreator };
}

/**
 * Resolve a mutable pointer (on-chain registry address) to an ipfs:// URL
 * by looking up the current log head CID.
 */
export async function resolvePointerToIpfsUrl(
  pointer: string,
  provider: CardProvider,
): Promise<string | null> {
  try {
    const cid = await provider.getLogHead(pointer);
    if (!cid) return null;
    return `ipfs://${cid}`;
  } catch {
    return null;
  }
}
