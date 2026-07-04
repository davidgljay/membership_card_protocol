import { canonicalize } from '../crypto/canonicalize.js';
import { mlDsa44Sign } from '../crypto/mldsa.js';
import { keccak256 } from '../crypto/hashes.js';
import { bytesToBase64Url } from '../util/base64url.js';
import type { ObliviousProtocolTransport } from '../providers/ObliviousProtocolTransport.js';

/**
 * Sub-card deregistration (`subcards.md §Authorization for Deregistration`,
 * `§Deregistration After Key Recovery`; `registry_contract.md §4.4
 * DeregisterSubCard`; `press.md §5.4 processSubCardDeregistration`).
 *
 * This is the primitive `plans/client-sdk/implementation-plan.md` names as
 * Phase 4 Step 4.4's — built here, ahead of Phase 4, per Step 2.5's own
 * explicit allowance ("build the primitive here and have Phase 4 reuse
 * it"), since Step 2.5 (post-recovery batch deregistration) needs it now.
 *
 * Structural enforcement of `subcards.md`'s authorization rule ("requires a
 * signature from the holder's primary card key — not from the sub-card key
 * itself, and not from the app"): unlike `registerSubCard`'s injected
 * callback shape (`deviceSubCard.ts`), this module has no "signer" callback
 * at all — {@link deregisterSubCard} takes `masterSecretKey: Uint8Array`
 * directly and signs internally, so there is no SDK-exposed code path that
 * could construct a deregistration request signed by anything else.
 */

interface DeregisterSubCardPayloadFields {
  op: 'deregister_sub_card';
  sub_card_address: string;
  timestamp: string;
}

export interface DeregisterSubCardOptions {
  transport: ObliviousProtocolTransport;
  /** The press to submit through — per policy, a card's approved presses may differ per sub-card. */
  press: { baseUrl: string };
  /** Raw ML-DSA-44 public key of the sub-card being deregistered. */
  subCardPublicKey: Uint8Array;
  /** The holder's primary (master) card private key — the only signer this operation accepts. */
  masterSecretKey: Uint8Array;
}

export interface DeregisterSubCardResult {
  txHash: string;
}

interface DeregisterSubCardResponseBody {
  tx_hash: string;
}

/**
 * `POST /sub-card/deregister` (`press.md §5.4`). Submits a master-key-signed
 * request marking `subCardPublicKey`'s sub-card inactive on-chain.
 */
export async function deregisterSubCard(options: DeregisterSubCardOptions): Promise<DeregisterSubCardResult> {
  const subCardAddress = keccak256(options.subCardPublicKey);
  const sigPayload: DeregisterSubCardPayloadFields = {
    op: 'deregister_sub_card',
    sub_card_address: subCardAddress,
    timestamp: new Date().toISOString(),
  };
  const masterSignature = mlDsa44Sign(options.masterSecretKey, canonicalize(sigPayload));

  const response = await options.transport.request(
    { kind: 'press', baseUrl: options.press.baseUrl },
    {
      method: 'POST',
      path: '/sub-card/deregister',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(
        JSON.stringify({
          sub_card_address: subCardAddress,
          sig_payload: sigPayload,
          master_signature: bytesToBase64Url(masterSignature),
        })
      ),
    }
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`deregisterSubCard: POST /sub-card/deregister returned status ${response.status}`);
  }
  const body = JSON.parse(new TextDecoder().decode(response.body)) as DeregisterSubCardResponseBody;
  return { txHash: body.tx_hash };
}

export interface PreviouslyActiveSubCard {
  subCardPublicKey: Uint8Array;
  press: { baseUrl: string };
}

export interface SubCardDeregistrationOutcome {
  subCardAddress: string;
  deregistered: boolean;
  txHash?: string;
  error?: string;
}

/**
 * `subcards.md §Deregistration After Key Recovery`: after recovery, every
 * sub-card active before the loss should be deregistered with the newly
 * recovered primary key, since an attacker who held the old key could have
 * deregistered/re-registered their own. "The press handles deregistration
 * of multiple sub-cards in sequence; the holder signs each individually or
 * the wallet produces a batch of signed deregistration requests" — this
 * signs and submits each independently (one press call per sub-card, since
 * different sub-cards may have been registered through different presses)
 * and never lets one failure abort the rest of the batch, since a holder
 * recovering their wallet needs every OTHER app's sub-card revoked even if
 * one press is temporarily unreachable.
 *
 * Judgment call: `previouslyActiveSubCards` is supplied by the caller
 * (e.g. from its own cached card list / registration records) rather than
 * re-derived here — neither the recovered keyring (`KeyringEntry` only
 * ever stores card private keys, never sub-card public keys or addresses)
 * nor anything else this SDK persists tracks which sub-cards were issued,
 * so there is nothing for this function to independently re-derive from.
 */
export async function deregisterSubCardsAfterRecovery(
  transport: ObliviousProtocolTransport,
  masterSecretKey: Uint8Array,
  previouslyActiveSubCards: PreviouslyActiveSubCard[]
): Promise<SubCardDeregistrationOutcome[]> {
  const outcomes: SubCardDeregistrationOutcome[] = [];
  for (const subCard of previouslyActiveSubCards) {
    const subCardAddress = keccak256(subCard.subCardPublicKey);
    try {
      const { txHash } = await deregisterSubCard({
        transport,
        press: subCard.press,
        subCardPublicKey: subCard.subCardPublicKey,
        masterSecretKey,
      });
      outcomes.push({ subCardAddress, deregistered: true, txHash });
    } catch (err) {
      outcomes.push({ subCardAddress, deregistered: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return outcomes;
}
