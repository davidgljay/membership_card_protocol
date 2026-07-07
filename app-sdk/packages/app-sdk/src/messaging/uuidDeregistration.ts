import { canonicalize } from '../crypto/canonicalize.js';
import { bytesToBase64Url } from '../util/base64url.js';
import { randomBytes } from '@noble/hashes/utils.js';
import type { ObliviousProtocolTransport } from '../providers/ObliviousProtocolTransport.js';

/**
 * UUID pool deregistration (Step 5.6): `DELETE
 * /cards/{card_hash}/subcards/{subcard_hash}`
 * (`notification_relay.md §Multi-Device Support "Deregistration"`,
 * v0.9's authentication requirement). Structurally identical to
 * registration (`uuidRegistration.ts`'s `registerCardUuids`) minus the
 * `uuids` field — the signed envelope proves control of the subcard's
 * private key, since deregistration carries no UUID list of its own.
 *
 * **This is emphatically not on-chain sub-card revocation.** The spec is
 * explicit and repeated on this point: wallet-service-local deregistration
 * (this function) empties this wallet-service instance's UUID pool for
 * the subcard; it never reads or writes `SubCardEntry.active`, has no
 * effect on message deliverability beyond emptying the pool, and is fully
 * reversible — a subcard that deregisters and then calls
 * `registerCardUuids` again immediately resumes normal delivery. On-chain
 * sub-card revocation (`subcards/revocation.ts`'s `revokeSubCard`, 8xx/9xx)
 * is a completely different mechanism, at a different layer, gated by a
 * different authority (the user/app for 8xx, governance for 9xx) — this
 * module and that one share no code and no on-chain state, by design, not
 * by oversight.
 */

export interface UuidDeregistrationPayload {
  card_hash: string;
  subcard_hash: string;
  timestamp: string;
  nonce: string;
}

export interface DeregisterCardUuidsOptions {
  transport: ObliviousProtocolTransport;
  cardHash: string;
  subCardHash: string;
  /** Signs the deregistration payload with the subcard's own private key — proving control, exactly as `registerCardUuids` requires for registration. */
  sign: (message: Uint8Array) => Uint8Array | Promise<Uint8Array>;
  /** Defaults to now. */
  timestamp?: string;
}

export interface DeregisterCardUuidsResult {
  deregistered: boolean;
}

/**
 * `DELETE /cards/{card_hash}/subcards/{subcard_hash}`. Succeeds (204, per
 * `notification_relay.md`) only with a valid signed envelope proving
 * control of the named subcard; the wallet service rejects (400/401/403)
 * an invalid or missing signature, and returns 404 if this subcard was
 * never registered with this wallet service at all — both surfaced here
 * as `{ deregistered: false }` rather than a thrown exception, since a
 * caller attempting to deregister an already-unregistered or
 * signature-mismatched subcard is an expected outcome to report, not an
 * infrastructure failure.
 */
export async function deregisterCardUuids(
  options: DeregisterCardUuidsOptions
): Promise<DeregisterCardUuidsResult> {
  const payload: UuidDeregistrationPayload = {
    card_hash: options.cardHash,
    subcard_hash: options.subCardHash,
    timestamp: options.timestamp ?? new Date().toISOString(),
    nonce: bytesToBase64Url(randomBytes(32)),
  };
  const signature = await options.sign(canonicalize(payload));

  const response = await options.transport.request(
    { kind: 'wallet_service' },
    {
      method: 'DELETE',
      path: `/cards/${options.cardHash}/subcards/${options.subCardHash}`,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(
        JSON.stringify({ payload, signature: bytesToBase64Url(signature) })
      ),
    }
  );

  return { deregistered: response.status >= 200 && response.status < 300 };
}
