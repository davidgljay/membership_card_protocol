/**
 * Open offer claim handler (press.md §5.2).
 * POST /open-offer/claim
 */

import type { PressContext } from '../context.js';
import { canonicalize, canonicalizeExcluding } from '../serialization.js';
import { keccak256, toBase64url, fromBase64url } from '../functions/crypto.js';
import { mlDsa44Verify } from '@membership-card-protocol/verifier';
import {
  assembleCardDocument,
  signCardDocument,
  publishCard,
  issueScip,
  fetchPolicyCard,
} from '../functions/issuance.js';
import { evaluatePredicates, recordWrite } from '../functions/predicates.js';
import { appendIssuanceRecord } from '../functions/log.js';
import type { OpenOfferClaimSubmission, OpenOfferClaimResponse } from '../types.js';
import type { Hex } from 'viem';

const UINT64_MAX = 18446744073709551615n;

export async function handleOpenOfferClaim(
  ctx: PressContext,
  body: OpenOfferClaimSubmission
): Promise<OpenOfferClaimResponse> {
  const { claim_payload, recipient_signature } = body;
  const { offer, recipient_pubkey } = claim_payload;

  // 1. Confirm press_card matches this press.
  if (offer.press_card !== ctx.config.PRESS_CARD_CID) {
    throw Object.assign(
      new Error(`P-01: offer.press_card does not match this press`),
      { pressCode: 'P-01' }
    );
  }

  // 2. Resolve policy.
  const policy = await fetchPolicyCard(ctx.ipfs, offer.policy_id);
  if (!policy.allow_open_offers) {
    throw Object.assign(
      new Error('P-01: Policy does not allow open offers'),
      { pressCode: 'P-01' }
    );
  }

  // 3. Verify issuer binding: keccak256(issuer_pubkey) == issuer_card address.
  const issuerPubkeyBytes = fromBase64url(offer.issuer_signature.public_key);
  const derivedAddress = '0x' + Buffer.from(keccak256(issuerPubkeyBytes)).toString('hex');
  if (derivedAddress.toLowerCase() !== offer.issuer_card.toLowerCase()) {
    throw Object.assign(
      new Error('P-05: issuer_signature.public_key binding check failed'),
      { pressCode: 'P-05' }
    );
  }

  // 4. Verify issuer signature over canonical offer excluding issuer_signature.
  const { issuer_signature: _sig, ...offerWithoutSig } = offer;
  const toVerifyIssuer = canonicalizeExcluding(offerWithoutSig as Record<string, unknown>, ['issuer_signature']);
  const issuerSigValid = mlDsa44Verify(
    issuerPubkeyBytes,
    toVerifyIssuer,
    fromBase64url(offer.issuer_signature.signature)
  );
  if (!issuerSigValid) {
    throw Object.assign(new Error('P-05: Invalid issuer_signature'), { pressCode: 'P-05' });
  }

  // 5. Verify recipient signature over canonical claim_payload.
  const claimBytes = canonicalize(claim_payload as Record<string, unknown>);
  const recipientPubkeyBytes = fromBase64url(recipient_signature.public_key);
  const recipientSigValid = mlDsa44Verify(
    recipientPubkeyBytes,
    claimBytes,
    fromBase64url(recipient_signature.signature)
  );
  if (!recipientSigValid) {
    throw Object.assign(new Error('P-06: Invalid recipient_signature'), { pressCode: 'P-06' });
  }

  // 6. Evaluate predicates (issuer as requester, recipient is new holder).
  await evaluatePredicates(
    ctx.verifier,
    policy,
    offer.issuer_card,
    offer.issuer_card, // recipient chain = issuer chain for open offers with new recipients
    ctx.config.STALENESS_WINDOW_SECONDS
  );

  // 7. Pre-flight on-chain use-count check.
  const offerId = ('0x' + Buffer.from(keccak256(canonicalize(offer as Record<string, unknown>))).toString('hex')) as Hex;
  const useCount = await ctx.registry.getOpenOfferUseCount(offerId);
  const maxAcceptances = offer.max_acceptances != null ? BigInt(offer.max_acceptances) : UINT64_MAX;
  const expiresAt = offer.expires_at ? BigInt(Math.floor(new Date(offer.expires_at).getTime() / 1000)) : 0n;

  if (expiresAt > 0n && BigInt(Math.floor(Date.now() / 1000)) >= expiresAt) {
    throw Object.assign(new Error('P-07: Open offer has expired'), { pressCode: 'P-07' });
  }
  if (maxAcceptances !== UINT64_MAX && useCount >= maxAcceptances) {
    throw Object.assign(new Error('P-08: Open offer is at capacity'), { pressCode: 'P-08' });
  }

  // 8. Assemble, sign, publish card.
  const protocolVersion = await ctx.registry.getProtocolVersion();
  const assembled = assembleCardDocument(
    ctx.config,
    offer as import('../types.js').IssuerOffer,
    recipient_pubkey,
    recipient_signature,
    [], // ancestry: Phase 3 placeholder
    protocolVersion
  );
  const signed = signCardDocument(ctx.config, assembled);
  const cardCid = await publishCard(signed, ctx.ipfs);

  // 9. Register on-chain via ClaimOpenOffer.
  const recipientPubBytes = fromBase64url(recipient_pubkey);
  const cardAddress = ('0x' + Buffer.from(keccak256(recipientPubBytes)).toString('hex')) as Hex;
  const policyAddress = ('0x' + Buffer.from(keccak256(new TextEncoder().encode(offer.policy_id))).toString('hex')) as Hex;

  await ctx.gas.checkGasBalance('ClaimOpenOffer');
  await ctx.registry.claimOpenOffer({
    offerId,
    maxAcceptances,
    expiresAt,
    cardAddress,
    initialLogCid: new TextEncoder().encode(cardCid),
    policyAddress,
  });

  // 10. Append issuance record.
  await appendIssuanceRecord(
    ctx.config, ctx.ipfs,
    offer.policy_id, cardCid, recipient_pubkey, '', 'open'
  );

  // 11. Issue SCIP.
  const adminUrl = policy['admin_wallet_service_url'] as string | undefined;
  const scip = await issueScip(
    ctx.config, cardCid, 0, cardCid, offer.issued_at, undefined, adminUrl
  );

  await recordWrite(ctx.kv, 'register_card', offer.issuer_card, 'holder', offer.policy_id, policy);

  return { card_cid: cardCid, scip };
}
