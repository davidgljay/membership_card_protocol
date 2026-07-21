/**
 * Sub-card registration and deregistration handlers (press.md §5.4).
 * POST /sub-card/register
 * POST /sub-card/deregister
 */

import type { PressContext } from '../context.js';
import { canonicalize, canonicalizeExcluding } from '../serialization.js';
import { keccak256, fromBase64url } from '../functions/crypto.js';
import { mlDsa44Verify } from '@membership-card-protocol/verifier';
import { checkRateLimits, recordWrite } from '../functions/predicates.js';
import { fetchPolicyCard } from '../functions/issuance.js';
import type {
  SubCardRegistrationRequest,
  SubCardRegistrationResponse,
  SubCardDeregistrationRequest,
  SubCardDeregistrationResponse,
} from '../types.js';
import type { Hex } from 'viem';

// ---------------------------------------------------------------------------
// POST /sub-card/register
// ---------------------------------------------------------------------------

export async function handleSubCardRegister(
  ctx: PressContext,
  body: SubCardRegistrationRequest
): Promise<SubCardRegistrationResponse> {
  const { sub_card_document: doc, holder_signature } = body;

  // 1. Verify app_signature over canonical doc excluding both signature fields.
  const docForAppSig = { ...doc };
  delete (docForAppSig as Record<string, unknown>)['app_signature'];
  delete (docForAppSig as Record<string, unknown>)['holder_signature'];
  const appSigBytes = canonicalize(docForAppSig as Record<string, unknown>);
  const appPubkey = fromBase64url(doc.app_card_pubkey);
  const appSigValid = mlDsa44Verify(
    appPubkey,
    appSigBytes,
    fromBase64url(doc.app_signature)
  );
  if (!appSigValid) {
    throw Object.assign(
      new Error('P-13: Invalid app_signature on SubCardDocument'),
      { pressCode: 'P-13' }
    );
  }

  // 2. Binding check: keccak256(holder_primary_card_pubkey) == holder_primary_card address.
  // Unprefixed, matching the convention `keccak256()` documents and that
  // wallet-sdk's `cardPointer`/offer-binding checks use for the same
  // comparison elsewhere in the protocol.
  const holderPubBytes = fromBase64url(doc.holder_primary_card_pubkey);
  const derivedHolderAddr = Buffer.from(keccak256(holderPubBytes)).toString('hex');
  if (derivedHolderAddr.toLowerCase() !== doc.holder_primary_card.toLowerCase()) {
    throw Object.assign(
      new Error('P-13: holder_primary_card_pubkey binding check failed'),
      { pressCode: 'P-13' }
    );
  }

  // 3. Binding check: keccak256(app_card_pubkey) == app_card address.
  const derivedAppAddr = Buffer.from(keccak256(appPubkey)).toString('hex');
  if (derivedAppAddr.toLowerCase() !== doc.app_card.toLowerCase()) {
    throw Object.assign(
      new Error('P-13: app_card_pubkey binding check failed'),
      { pressCode: 'P-13' }
    );
  }

  // 4. Verify holder_signature over canonical doc including app_signature, excluding holder_signature.
  const docWithAppSig = { ...doc };
  delete (docWithAppSig as Record<string, unknown>)['holder_signature'];
  const holderSigBytes = canonicalize(docWithAppSig as Record<string, unknown>);
  const holderSigValid = mlDsa44Verify(
    holderPubBytes,
    holderSigBytes,
    fromBase64url(holder_signature)
  );
  if (!holderSigValid) {
    throw Object.assign(
      new Error('P-14: Invalid holder_signature on SubCardDocument'),
      { pressCode: 'P-14' }
    );
  }

  // 5. Verify app certification chain.
  const appResult = await ctx.verifier.verifyCard(doc.app_card);
  if (appResult.chain_reaches_trusted_root !== true || appResult.is_currently_valid === false) {
    throw Object.assign(
      new Error('P-15: App card chain does not reach governance app-certification policy root'),
      { pressCode: 'P-15' }
    );
  }

  // 6. Attestation level check.
  if (doc.attestation_level !== 'T2') {
    // Check policy: Phase 3 passes T1 as well (operator configures this in policy).
    console.warn('[press] Sub-card has T1 attestation — policy check deferred to Phase 4');
  }

  // 7. Rate limits.
  const holderAddress = doc.holder_primary_card;
  const appCardAddress = doc.app_card;
  const policyCid = ctx.config.PRESS_POLICY_CIDS[0] ?? '';
  await checkRateLimits(ctx.kv, 'register_sub_card', holderAddress, 'holder', policyCid);
  await checkRateLimits(ctx.kv, 'register_sub_card_app', appCardAddress, 'app_card', policyCid);

  // 8. Check app gas balance.
  const gasCheck = await ctx.gas.checkAppGasBalance(appCardAddress, 'RegisterSubCard');
  if (!gasCheck.sufficient) {
    throw Object.assign(
      new Error('P-16: App gas account balance insufficient for RegisterSubCard'),
      { pressCode: 'P-16' }
    );
  }

  // 9. Pin SubCardDocument to IPFS.
  const fullDoc = { ...doc, holder_signature };
  const docBytes = canonicalize(fullDoc as Record<string, unknown>);
  const subCardDocCid = await ctx.ipfs.pinToIPFS(docBytes);

  // 10. Register on-chain.
  const masterCardAddress = doc.holder_primary_card as Hex;
  const masterEntry = await ctx.registry.getCardEntry(masterCardAddress);
  const subCardPubBytes = fromBase64url(doc.recipient_pubkey);
  const subCardAddress = ('0x' + Buffer.from(keccak256(subCardPubBytes)).toString('hex')) as Hex;

  const txHash = await ctx.registry.registerSubCard({
    subCardAddress,
    masterCardAddress,
    registrationLogHead: masterEntry.log_head_cid,
    subCardDocCid: new TextEncoder().encode(subCardDocCid),
    adminSecpPayload: body.admin_secp_payload
      ? new TextEncoder().encode(body.admin_secp_payload)
      : new Uint8Array(0),
    adminSecpSignature: body.admin_secp_signature
      ? fromBase64url(body.admin_secp_signature)
      : new Uint8Array(64),
  });

  // Record rate-limit counters.
  let policy: import('../types.js').PolicyDocument;
  try {
    policy = await fetchPolicyCard(ctx.ipfs, policyCid);
  } catch {
    policy = { field_definitions: {}, approved_presses: [] } as import('../types.js').PolicyDocument;
  }
  await recordWrite(ctx.kv, 'register_sub_card', holderAddress, 'holder', policyCid, policy);
  await recordWrite(ctx.kv, 'register_sub_card_app', appCardAddress, 'app_card', policyCid, policy);

  return { sub_card_doc_cid: subCardDocCid, tx_hash: txHash };
}

// ---------------------------------------------------------------------------
// POST /sub-card/deregister
// ---------------------------------------------------------------------------

export async function handleSubCardDeregister(
  ctx: PressContext,
  body: SubCardDeregistrationRequest
): Promise<SubCardDeregistrationResponse> {
  const subCardAddress = body.sub_card_address as Hex;

  // 1. Confirm sub-card is active.
  const subEntry = await ctx.registry.getSubCardEntry(subCardAddress);
  if (!subEntry.active) {
    throw Object.assign(
      new Error('Sub-card is not active or does not exist'),
      { pressCode: 'P-01' }
    );
  }

  // 2. Fetch master card's public key.
  const masterAddress = subEntry.master_card_address as Hex;
  const masterEntry = await ctx.registry.getCardEntry(masterAddress);

  // Fetch the SubCardDocument from IPFS to get holder_primary_card_pubkey.
  const cidStr = new TextDecoder().decode(subEntry.sub_card_doc_cid);
  const subDocBytes = await ctx.ipfs.fetchFromIPFS(cidStr);
  const subDoc = JSON.parse(new TextDecoder().decode(subDocBytes)) as {
    holder_primary_card_pubkey: string;
  };
  const masterPubkey = fromBase64url(subDoc.holder_primary_card_pubkey);

  // 3. Verify master signature over sig_payload.
  const sigPayloadBytes = canonicalize(body.sig_payload as unknown as Record<string, unknown>);
  const sigValid = mlDsa44Verify(
    masterPubkey,
    sigPayloadBytes,
    fromBase64url(body.master_signature)
  );
  if (!sigValid) {
    throw Object.assign(
      new Error('P-14: Invalid master_signature on deregistration request'),
      { pressCode: 'P-14' }
    );
  }

  // 4. Gas check — sponsor if app balance is zero (spec §5.4).
  const appCardAddress = ''; // resolve from SubCardDocument in Phase 4
  const gasCheck = await ctx.gas.checkAppGasBalance(subCardAddress, 'DeregisterSubCard');
  if (!gasCheck.sufficient && !gasCheck.sponsor) {
    throw Object.assign(new Error('Gas check failed'), { pressCode: 'P-20' });
  }
  // If sponsor == true, the press self-funds (gas.checkGasBalance handles this).
  if (gasCheck.sponsor) {
    await ctx.gas.checkGasBalance('DeregisterSubCard');
  }

  // 5. Submit DeregisterSubCard.
  const txHash = await ctx.registry.deregisterSubCard({
    subCardAddress,
    sigPayload: sigPayloadBytes,
    signature: fromBase64url(body.master_signature),
  });

  return { tx_hash: txHash };
}
