/**
 * Card issuance functions (press.md §5.1).
 *
 * validateIssuanceRequest → evaluatePredicates → assembleCardDocument →
 * signCardDocument → publishCard → registerCardOnChain → issueScip
 */

import type { CardVerifier } from '@membership-card-protocol/verifier';
import type { PressConfig } from '../config.js';
import type { KvStore } from '../kv.js';
import { kvKeys, type OfferRecord } from '../kv.js';
import type { IpfsClient } from '../ipfs/client.js';
import type { RegistryClient } from '../chain/registry.js';
import type { GasManager } from '../chain/gas.js';
import { canonicalize, canonicalizeExcluding } from '../serialization.js';
import {
  mlDsa44Sign,
  aes256gcmEncrypt,
  deriveContentKey,
  keccak256,
  toBase64url,
  fromBase64url,
  mlDsa44PublicKeyFromPrivate,
} from './crypto.js';
import { mlDsa44Verify } from '@membership-card-protocol/verifier';
import { evaluatePredicates } from './predicates.js';
import type {
  PolicyDocument,
  IssuerOffer,
  IssuanceRequest,
  FinalizeRequest,
  ScipObject,
  PastKey,
  SignatureField,
} from '../types.js';
import type { Hex } from 'viem';

// ---------------------------------------------------------------------------
// Policy card resolution
// ---------------------------------------------------------------------------

export async function fetchPolicyCard(
  ipfs: IpfsClient,
  policyCid: string
): Promise<PolicyDocument> {
  const bytes = await ipfs.fetchFromIPFS(policyCid);
  return JSON.parse(new TextDecoder().decode(bytes)) as PolicyDocument;
}

// ---------------------------------------------------------------------------
// validateIssuanceRequest (press.md §5.1)
// ---------------------------------------------------------------------------

export async function validateIssuanceRequest(
  request: IssuanceRequest,
  config: PressConfig,
  kv: KvStore,
  verifier: CardVerifier,
  ipfs: IpfsClient
): Promise<{ policy: PolicyDocument; policyAddress: string }> {
  // 1. Required fields.
  if (!request.policy_cid || !request.requester_card_address || !request.offer) {
    throw Object.assign(
      new Error('P-01: Missing required fields: policy_cid, requester_card_address, offer'),
      { pressCode: 'P-01' }
    );
  }

  // 2. Resolve policy card.
  const policy = await fetchPolicyCard(ipfs, request.policy_cid);

  // 3. Policy expiry.
  if (policy.valid_until && new Date(policy.valid_until) <= new Date()) {
    throw Object.assign(
      new Error(`P-21: Policy ${request.policy_cid} has expired (valid_until: ${policy.valid_until})`),
      { pressCode: 'P-21' }
    );
  }

  // 4. Press must be in approved_presses.
  if (!policy.approved_presses.includes(config.PRESS_CARD_CID)) {
    throw Object.assign(
      new Error(`P-01: This press (${config.PRESS_CARD_CID}) is not in the policy's approved_presses`),
      { pressCode: 'P-01' }
    );
  }

  // 5. Evaluate predicates (requester and recipient chains).
  const recipientAddress = request.recipient_card_address ?? '';
  if (recipientAddress) {
    await evaluatePredicates(
      verifier,
      policy,
      request.requester_card_address,
      recipientAddress,
      config.STALENESS_WINDOW_SECONDS
    );
  }

  // 6. Rate limit check.
  await import('./predicates.js').then((m) =>
    m.checkRateLimits(kv, 'register_card', request.requester_card_address, 'holder', request.policy_cid)
  );

  // Derive the policy's on-chain address = keccak256(policy_cid bytes).
  const policyAddress =
    '0x' + Buffer.from(keccak256(new TextEncoder().encode(request.policy_cid))).toString('hex');

  return { policy, policyAddress };
}

// ---------------------------------------------------------------------------
// assembleCardDocument (press.md §5.1)
// ---------------------------------------------------------------------------

export function assembleCardDocument(
  config: PressConfig,
  offer: IssuerOffer,
  recipientPubkey: string,
  holderSignature: SignatureField,
  ancestryPubkeys: string[],
  protocolVersion: string,
  pastKeys?: PastKey[]
): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    // Copy all offer fields (policy_id, issuer_card, issued_at, policy field values, issuer_signature).
    ...offer,
    // Add press fields.
    press_card: config.PRESS_CARD_CID,
    protocol_version: protocolVersion,
    recipient_pubkey: recipientPubkey,
    holder_signature: holderSignature,
    ancestry_pubkeys: ancestryPubkeys,
  };

  if (pastKeys && pastKeys.length > 0) {
    doc['past_keys'] = pastKeys;
  }

  return doc;
}

// ---------------------------------------------------------------------------
// signCardDocument (press.md §5.1)
// ---------------------------------------------------------------------------

export function signCardDocument(
  config: PressConfig,
  cardDocument: Record<string, unknown>
): Record<string, unknown> {
  // 1. Canonicalize excluding press_signature.
  const toSign = canonicalizeExcluding(cardDocument, ['press_signature']);
  // 2. Sign with press ML-DSA-44 private key.
  const signature = mlDsa44Sign(config.PRESS_MLDSA44_PRIVATE_KEY, toSign);
  const pubKey = mlDsa44PublicKeyFromPrivate(config.PRESS_MLDSA44_PRIVATE_KEY);

  // 3. Add press_signature.
  return {
    ...cardDocument,
    press_signature: {
      public_key: toBase64url(pubKey),
      signature: toBase64url(signature),
    },
  };
}

// ---------------------------------------------------------------------------
// publishCard (press.md §5.1)
// ---------------------------------------------------------------------------

export async function publishCard(
  signedCardDocument: Record<string, unknown>,
  ipfs: IpfsClient
): Promise<string> {
  const recipientPubkeyB64 = signedCardDocument['recipient_pubkey'] as string;
  const recipientPubkey = fromBase64url(recipientPubkeyB64);

  // 1. Derive content key.
  const contentKey = deriveContentKey(recipientPubkey);

  // 2. Encrypt canonical JSON with AES-256-GCM.
  const plaintext = canonicalize(signedCardDocument);
  const ciphertext = aes256gcmEncrypt(contentKey, plaintext);

  // 3. Upload to IPFS and validate CID.
  return ipfs.pinToIPFS(ciphertext);
}

// ---------------------------------------------------------------------------
// issueScip (press.md §5.1)
// ---------------------------------------------------------------------------

export async function issueScip(
  config: PressConfig,
  cardCid: string,
  policyLogEntryIndex: number,
  policyLogRootCid: string,
  issuedAt: string,
  recipientWalletServiceUrl?: string,
  adminWalletServiceUrl?: string
): Promise<ScipObject> {
  const pubKey = mlDsa44PublicKeyFromPrivate(config.PRESS_MLDSA44_PRIVATE_KEY);

  const scipBase: Record<string, unknown> = {
    card_cid: cardCid,
    policy_log_entry_index: policyLogEntryIndex,
    policy_log_root_at_inclusion: policyLogRootCid,
    issued_at: issuedAt,
  };

  // Sign excluding press_signature.
  const toSign = canonicalize(scipBase);
  const sig = mlDsa44Sign(config.PRESS_MLDSA44_PRIVATE_KEY, toSign);

  const scip: ScipObject = {
    ...scipBase as { card_cid: string; policy_log_entry_index: number; policy_log_root_at_inclusion: string; issued_at: string },
    press_signature: {
      public_key: toBase64url(pubKey),
      signature: toBase64url(sig),
    },
  };

  // Deliver to recipient wallet service.
  if (recipientWalletServiceUrl) {
    await deliverScip(scip, recipientWalletServiceUrl);
  }
  // Courtesy copy to admin.
  if (adminWalletServiceUrl) {
    await deliverScip(scip, adminWalletServiceUrl).catch((err) => {
      console.warn(`[press] Admin SCIP delivery failed: ${String(err)}`);
    });
  }

  return scip;
}

async function deliverScip(scip: ScipObject, url: string): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(scip),
  });
  if (!res.ok) {
    throw new Error(`SCIP delivery failed to ${url}: HTTP ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// Issuer signature verification
// ---------------------------------------------------------------------------

/**
 * Verify the issuer's ML-DSA-44 signature on the offer blob.
 * The signed bytes are the canonical RFC 8785 JSON of all offer fields
 * excluding issuer_signature.
 */
export function verifyIssuerSignature(offer: IssuerOffer): boolean {
  const { issuer_signature: sig, ...rest } = offer;
  const toVerify = canonicalizeExcluding(rest as Record<string, unknown>, ['issuer_signature']);
  const pubKey = fromBase64url(sig.public_key);
  const signature = fromBase64url(sig.signature);
  return mlDsa44Verify(pubKey, toVerify, signature);
}

/**
 * Verify holder countersignature over canonical JSON of the offer + recipient_pubkey,
 * excluding holder_signature and press_signature.
 */
export function verifyHolderSignature(
  cardDocument: Record<string, unknown>,
  holderSig: SignatureField
): boolean {
  const toVerify = canonicalizeExcluding(cardDocument, ['holder_signature', 'press_signature']);
  const pubKey = fromBase64url(holderSig.public_key);
  const signature = fromBase64url(holderSig.signature);
  return mlDsa44Verify(pubKey, toVerify, signature);
}
