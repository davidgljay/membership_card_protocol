/**
 * Issues a card whose issuer is an existing card (so the new card's chain runs
 * through it), using the same press /issue → /issue/finalize flow as
 * mintCard. Keys are deterministic: the issuer signs with
 * deriveKeypair(issuerHolderLabel) and the new holder key is
 * deriveKeypair(`holder:${label}`).
 */
import { assembleAndSignTargetedOffer, canonicalize, mlDsa44Sign, keccak256, bytesToBase64Url } from '@membership-card-protocol/app-sdk';
import { InMemorySecureKeyProvider, deriveKeypair } from './keys.js';

export interface MintChildCardOptions {
  pressBaseUrl: string;
  policyId: string;
  /** Key label of the issuing card's holder key, e.g. `holder:my-root`. */
  issuerHolderLabel: string;
  label: string;
  fieldValues?: Record<string, unknown>;
}

export async function mintChildCard(options: MintChildCardOptions): Promise<{ cardCid: string; address: string; publicKey: Uint8Array; secretKey: Uint8Array }> {
  const press = options.pressBaseUrl.replace(/\/$/, '');
  const keys = new InMemorySecureKeyProvider();
  const issuerPubkey = await keys.generateKey(options.issuerHolderLabel);
  const issuerAddress = keccak256(issuerPubkey);
  const pressInfo = (await (await fetch(`${press}/api/press`)).json()) as { press_card_cid: string };
  const offer = await assembleAndSignTargetedOffer({
    secureKeyProvider: keys,
    issuerSigningKeyId: options.issuerHolderLabel,
    policyId: options.policyId,
    issuerCard: issuerAddress,
    pressCard: pressInfo.press_card_cid,
    ancestryPubkeys: [issuerPubkey],
    fieldValues: options.fieldValues ?? {},
  });
  const issueRes = await fetch(`${press}/api/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ policy_cid: options.policyId, requester_card_address: issuerAddress, offer }),
  });
  if (!issueRes.ok) throw new Error(`mintChildCard: POST /issue failed: HTTP ${issueRes.status}: ${await issueRes.text()}`);
  const { offer_cid: offerCid } = (await issueRes.json()) as { offer_cid: string };

  const holder = deriveKeypair(`holder:${options.label}`);
  const recipientPubkey = bytesToBase64Url(holder.publicKey);
  const holderSignature = mlDsa44Sign(holder.secretKey, canonicalize({ ...offer, recipient_pubkey: recipientPubkey }));
  const finalizeRes = await fetch(`${press}/api/issue/finalize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offer_cid: offerCid, recipient_pubkey: recipientPubkey, holder_signature: bytesToBase64Url(holderSignature) }),
  });
  if (!finalizeRes.ok) throw new Error(`mintChildCard: POST /issue/finalize failed: HTTP ${finalizeRes.status}: ${await finalizeRes.text()}`);
  const { card_cid: cardCid } = (await finalizeRes.json()) as { card_cid: string };
  return { cardCid, address: keccak256(holder.publicKey), publicKey: holder.publicKey, secretKey: holder.secretKey };
}
