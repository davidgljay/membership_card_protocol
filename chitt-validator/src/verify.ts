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
  LogEntry,
  MessagePayload,
  SignatureEntry,
  SignatureResult,
} from './types.js';
import { canonicalize } from './serialization.js';
import { verifySignature } from './crypto.js';
import {
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
  /** policy_id CID extracted from the master chitt (if resolved). */
  policyCid: string | null;
  /** press_chitt pointer extracted from the master chitt (if resolved). */
  pressChittPointer: string | null;
  /** press_chitt pointer extracted from the policy chitt (if resolved). */
  policyCreatorPointer: string | null;
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
  // This is a purely local check (no network); including it even when the
  // signature is invalid lets the application know whether the message was
  // addressed to this verifier regardless of validity.
  // -------------------------------------------------------------------------
  const addressedToVerifier =
    opts.verifierChitt !== undefined &&
    opts.payload.recipients.includes(opts.verifierChitt);

  // -------------------------------------------------------------------------
  // Stage 1: Signature validity
  // Verify ML-DSA-44 signature over canonical CBOR of the payload.
  // No network call required.
  // -------------------------------------------------------------------------
  const payloadBytes = canonicalize(opts.payload as unknown as Record<string, unknown>);
  const sigValid = verifySignature(entry.public_key, payloadBytes, entry.signature);

  if (!sigValid) {
    return {
      result: { ...baseResult, signature_valid: false, addressed_to_verifier: addressedToVerifier },
      policyCid: null,
      pressChittPointer: null,
      policyCreatorPointer: null,
    };
  }

  // -------------------------------------------------------------------------
  // Stage 2: Sub-chitt → master link
  // -------------------------------------------------------------------------
  let masterChittAddress: string | null = null;
  let masterChitt: ChittDocument | null = null;
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
    };
  }

  // -------------------------------------------------------------------------
  // Stage 3: Chain walk — historical (IPFS)
  // Fetch the master chitt's current log head and walk ancestry.
  // -------------------------------------------------------------------------
  let chainReachesTrustedRoot = false;

  try {
    const masterLogHeadCid = await opts.provider.getLogHead(masterChittAddress);
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
      };
    }

    masterChitt = (await opts.provider.fetchIPFS(masterLogHeadCid)) as ChittDocument;
    policyCid = masterChitt.policy_id ?? null;
    pressChittPointer = masterChitt.press_chitt ?? null;

    // Check if the master chitt or any ancestor reaches a trusted root
    chainReachesTrustedRoot = opts.trustedRoots.includes(masterChittAddress);

    if (!chainReachesTrustedRoot && policyCid) {
      // Walk the press sub-chitt chain to look for a trusted root
      chainReachesTrustedRoot = await walkChainForTrustedRoot(
        masterChitt,
        opts.provider,
        opts.trustedRoots,
      );
    }

    // Fetch the policy chitt to extract the policyCreator pointer
    if (policyCid) {
      try {
        const policyChitt = (await opts.provider.fetchIPFS(policyCid)) as ChittDocument;
        policyCreatorPointer = policyChitt.press_chitt ?? null;
      } catch {
        // Non-fatal: policy chitt may not be pinned; links still partially populated
      }
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
    };
  }

  // -------------------------------------------------------------------------
  // Stage 4: Revocation check — current (Arbitrum One + IPFS log)
  // Check all links in the chain for revocation entries.
  // -------------------------------------------------------------------------
  let revResult = { status: 'none' as const, code: null as number | null, effective_date: null as string | null, data_freshness_seconds: 0 };
  let wasValidAtSigning = true;
  let currentlyValid = true;

  try {
    const masterLogHeadCid = await opts.provider.getLogHead(masterChittAddress!);
    if (masterLogHeadCid) {
      const { entries, fetchedAt } = await opts.provider.getRevocationEntries(
        masterChittAddress!,
        masterLogHeadCid,
      );
      const governing = findGoverningRevocation(entries);
      revResult = revocationStatus(governing, fetchedAt);

      // Check freshness
      if (revResult.data_freshness_seconds > opts.freshnessWindowSeconds) {
        // Stale data: treat as unable to confirm validity
        currentlyValid = false;
      } else {
        wasValidAtSigning = wasValidAtSigningTime(governing, opts.signingTimeMs);
        currentlyValid = isCurrentlyValid(governing, nowMs);
      }
    }
  } catch (err) {
    // Revocation lookup failed — flag as not currently valid (conservative)
    currentlyValid = false;
    revResult = { ...revResult, data_freshness_seconds: opts.freshnessWindowSeconds + 1 };
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
  };
}

/**
 * Walk the press sub-chitt chain from a master chitt, checking if any link
 * reaches a trusted root address.
 */
async function walkChainForTrustedRoot(
  chitt: ChittDocument,
  provider: ChittProvider,
  trustedRoots: string[],
  depth = 0,
): Promise<boolean> {
  // Prevent infinite loops; chain depth is expected to be small
  if (depth > 20) return false;

  const pressPointer = chitt.press_chitt;
  if (!pressPointer) return false;

  if (trustedRoots.includes(pressPointer)) return true;

  try {
    const pressLogHeadCid = await provider.getLogHead(pressPointer);
    if (!pressLogHeadCid) return false;
    const pressChitt = (await provider.fetchIPFS(pressLogHeadCid)) as ChittDocument;
    return walkChainForTrustedRoot(pressChitt, provider, trustedRoots, depth + 1);
  } catch {
    return false;
  }
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
