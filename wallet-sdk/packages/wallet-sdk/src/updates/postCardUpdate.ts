/**
 * Posts a signed UpdateIntentPayload (protocol-objects.md §4) to a press's
 * `POST /api/update` (press.md §5.3, process_specs/card_updates.md step 5).
 *
 * Request body: `{ update_intent, intent_signature: { public_key, signature },
 * target_card_pubkey? }`. The press needs the signer's public key to verify
 * the signature, and the target card's public key to read and encrypt the
 * card's log (ADR-006) — for a self-update the signer's key is the target's.
 */
import { canonicalize } from '@membership-card-protocol/app-sdk';
import { bytesToBase64Url } from '@membership-card-protocol/app-sdk';
import type { ObliviousProtocolTransport } from '@membership-card-protocol/app-sdk';

export interface UpdateIntent {
  target_card: string;
  updater_card: string;
  code: number;
  timestamp: string;
  notify_holder: boolean;
  field_updates?: { field: string; value: unknown }[];
  revocation?: { effective_date: string; note?: string };
  updater_message?: string;
  note?: string;
}

export interface PostCardUpdateOptions {
  transport: ObliviousProtocolTransport;
  pressBaseUrl: string;
  intent: UpdateIntent;
  /** Signs the canonical intent with the updater card's key. */
  sign: (message: Uint8Array) => Uint8Array | Promise<Uint8Array>;
  /** base64url ML-DSA-44 public key of the updater card. */
  signerPublicKey: string;
  /** base64url public key of the target card; required when updater ≠ target. */
  targetCardPublicKey?: string;
}

export interface PostCardUpdateResult {
  logEntryCid: string;
  newLogHeadCid: string;
}

export async function postCardUpdate(options: PostCardUpdateOptions): Promise<PostCardUpdateResult> {
  const signature = await options.sign(canonicalize(options.intent));
  const body = {
    update_intent: options.intent,
    intent_signature: { public_key: options.signerPublicKey, signature: bytesToBase64Url(signature) },
    ...(options.targetCardPublicKey ? { target_card_pubkey: options.targetCardPublicKey } : {}),
  };
  const response = await options.transport.request(
    { kind: 'press', baseUrl: options.pressBaseUrl },
    {
      method: 'POST',
      path: '/api/update',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify(body)),
    }
  );
  if (response.status < 200 || response.status >= 300) {
    const detail = new TextDecoder().decode(response.body).slice(0, 300);
    throw new Error(`POST /update returned status ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  const parsed = JSON.parse(new TextDecoder().decode(response.body)) as { log_entry_cid: string; new_log_head_cid: string };
  return { logEntryCid: parsed.log_entry_cid, newLogHeadCid: parsed.new_log_head_cid };
}
