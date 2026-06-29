/**
 * Targeted card issuance handlers.
 *
 * handleIssue        — POST /issue: validate predicates, store offer in KV.
 * handleIssueFinalize — POST /issue/finalize: complete issuance, publish, register.
 */

import type { PressContext } from '../context.js';
import { kvKeys, type OfferRecord } from '../kv.js';
import { canonicalize } from '../serialization.js';
import { keccak256, toBase64url, fromBase64url } from '../functions/crypto.js';
import {
  validateIssuanceRequest,
  assembleCardDocument,
  signCardDocument,
  publishCard,
  issueScip,
  verifyIssuerSignature,
  verifyHolderSignature,
  fetchPolicyCard,
} from '../functions/issuance.js';
import { recordWrite } from '../functions/predicates.js';
import { appendIssuanceRecord } from '../functions/log.js';
import type { IssuanceRequest, FinalizeRequest, FinalizeResponse, IssuanceResponse } from '../types.js';
import { pressError } from '../types.js';
import type { Hex } from 'viem';

// ---------------------------------------------------------------------------
// POST /issue
// ---------------------------------------------------------------------------

export async function handleIssue(
  ctx: PressContext,
  body: IssuanceRequest
): Promise<IssuanceResponse> {
  // Validate and evaluate predicates.
  const { policy, policyAddress } = await validateIssuanceRequest(
    body,
    ctx.config,
    ctx.kv,
    ctx.verifier,
    ctx.ipfs
  );

  // Verify issuer signature on the offer.
  if (!verifyIssuerSignature(body.offer)) {
    throw Object.assign(
      new Error('P-05: Invalid issuer_signature on offer'),
      { pressCode: 'P-05' }
    );
  }

  // Stale timestamp check (P-22).
  const offerAge = Date.now() - new Date(body.offer.issued_at).getTime();
  const MAX_OFFER_AGE_MS = ctx.config.STALENESS_WINDOW_SECONDS * 1000;
  if (offerAge > MAX_OFFER_AGE_MS) {
    throw Object.assign(
      new Error('P-22: Offer timestamp is stale'),
      { pressCode: 'P-22' }
    );
  }

  // Derive a stable offer CID from the canonical offer bytes.
  const offerBytes = canonicalize(body.offer as Record<string, unknown>);
  const offerHash = keccak256(offerBytes);
  const offerCid = toBase64url(offerHash);

  // Store offer in KV.
  const offerRecord: OfferRecord = {
    policy_cid: body.policy_cid,
    created_at: Math.floor(Date.now() / 1000),
    finalized: false,
    expires_at: null,
  };
  await ctx.kv.setItem(kvKeys.offer(offerCid), offerRecord);

  // Store the full offer body alongside the record for retrieval in /finalize.
  await ctx.kv.setItem(`${kvKeys.offer(offerCid)}:body`, body.offer);

  return { offer_cid: offerCid };
}

// ---------------------------------------------------------------------------
// POST /issue/finalize
// ---------------------------------------------------------------------------

export async function handleIssueFinalize(
  ctx: PressContext,
  body: FinalizeRequest
): Promise<FinalizeResponse> {
  // Retrieve stored offer.
  const offerRecord = await ctx.kv.getItem<OfferRecord>(kvKeys.offer(body.offer_cid));
  if (!offerRecord) {
    throw Object.assign(
      new Error('Offer not found or expired'),
      { pressCode: 'P-01' }
    );
  }
  if (offerRecord.finalized) {
    throw Object.assign(
      new Error('Offer already finalized'),
      { pressCode: 'P-01' }
    );
  }

  const offer = await ctx.kv.getItem<Record<string, unknown>>(`${kvKeys.offer(body.offer_cid)}:body`);
  if (!offer) {
    throw Object.assign(new Error('Offer body missing'), { pressCode: 'P-01' });
  }

  // Verify holder signature over canonical(offer + recipient_pubkey) excluding holder/press sigs.
  const partialDoc = {
    ...offer,
    press_card: ctx.config.PRESS_CARD_CID,
    recipient_pubkey: body.recipient_pubkey,
  };
  if (!verifyHolderSignature(partialDoc, body.holder_signature)) {
    throw Object.assign(
      new Error('P-05: Invalid holder_signature'),
      { pressCode: 'P-05' }
    );
  }

  // Assemble, sign, and publish card.
  const policy = await fetchPolicyCard(ctx.ipfs, offerRecord.policy_cid);
  const ancestry: string[] = []; // Phase 3: ancestry chain walk deferred to Phase 4.
  const protocolVersion = await ctx.registry.getProtocolVersion();

  const assembled = assembleCardDocument(
    ctx.config,
    offer as import('../types.js').IssuerOffer,
    body.recipient_pubkey,
    body.holder_signature,
    ancestry,
    protocolVersion,
    body.past_keys
  );

  const signed = signCardDocument(ctx.config, assembled);
  const cardCid = await publishCard(signed, ctx.ipfs);

  // Register on-chain.
  const recipientPubkeyBytes = fromBase64url(body.recipient_pubkey);
  const cardAddress = ('0x' + Buffer.from(keccak256(recipientPubkeyBytes)).toString('hex')) as Hex;
  const policyAddress = ('0x' + Buffer.from(keccak256(new TextEncoder().encode(offerRecord.policy_cid))).toString('hex')) as Hex;

  await ctx.gas.checkGasBalance('RegisterCard');
  await ctx.registry.registerCard({
    cardAddress,
    initialLogCid: new TextEncoder().encode(cardCid),
    policyAddress,
  });

  // Append issuance record (notify auditors).
  await appendIssuanceRecord(
    ctx.config,
    ctx.ipfs,
    offerRecord.policy_cid,
    cardCid,
    body.recipient_pubkey,
    '',
    'targeted'
  );

  // Issue SCIP.
  const issuedAt = (offer['issued_at'] as string) ?? new Date().toISOString();
  const adminUrl = policy['admin_wallet_service_url'] as string | undefined;
  const scip = await issueScip(ctx.config, cardCid, 0, cardCid, issuedAt, undefined, adminUrl);

  // Mark offer finalized.
  await ctx.kv.setItem(kvKeys.offer(body.offer_cid), { ...offerRecord, finalized: true });

  // Record rate-limit write.
  const issuerCard = offer['issuer_card'] as string ?? '';
  await recordWrite(ctx.kv, 'register_card', issuerCard, 'holder', offerRecord.policy_cid, policy);

  return { card_cid: cardCid, scip };
}
