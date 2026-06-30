/**
 * Federation actions this instance initiates on its own behalf — as
 * opposed to server/routes/bindings/ and server/routes/federation/, which
 * handle messages *received* from peers. Called from Phase 2's account
 * creation (Step 2.2) and keyring rotation (Step 2.4) now that Phase 4
 * exists to receive them.
 */

import { loadConfig } from '../../src/config.js';
import { getPool } from '../db/client.js';
import { findRoutingEntry, upsertRoutingEntry, recordNonceIfNew } from '../db/routing.js';
import { buildRegistrationAnnouncement } from '../../src/federation/binding.js';
import {
  buildSignedKeyringMessage,
  buildSignedKeyringDeleteMessage,
} from '../../src/federation/keyring-sync.js';
import { broadcastAnnouncement, broadcastKeyring, broadcastKeyringDelete } from './federation-broadcast.js';

function privateKeyBytes(config: ReturnType<typeof loadConfig>): Uint8Array {
  return new Uint8Array(Buffer.from(config.WALLET_SERVICE_PRIVATE_KEY, 'base64url'));
}

/**
 * Records that this instance now holds `cardHash` in its own routing table
 * and announces it to all peers (message_routing.md §Wallet Service
 * Registry — "when a wallet service acquires a card... it broadcasts a
 * CardBindingAnnouncement to all peers").
 */
export async function announceOwnCardRegistration(cardHash: string): Promise<void> {
  const config = loadConfig();
  const envelope = buildRegistrationAnnouncement(
    cardHash,
    config.WALLET_SERVICE_ID,
    config.WALLET_SERVICE_ENDPOINT,
    privateKeyBytes(config)
  );

  const pool = getPool();
  const isNew = await recordNonceIfNew(pool, envelope.payload.nonce);
  if (isNew) {
    const existing = await findRoutingEntry(pool, cardHash);
    // A freshly self-generated announcement should never lose to a stale
    // local entry, but route through the same conflict-resolution-shaped
    // upsert for consistency with how peer announcements are applied.
    if (!existing || existing.wallet_service_id !== config.WALLET_SERVICE_ID) {
      await upsertRoutingEntry(pool, {
        card_hash: cardHash,
        wallet_service_id: envelope.payload.wallet_service_id,
        endpoint: envelope.payload.endpoint,
        type: envelope.payload.type,
        announced_at: new Date(envelope.payload.timestamp),
        nonce: envelope.payload.nonce,
        signatures: envelope.signatures,
      });
    }
  }

  await broadcastAnnouncement(envelope);
}

export async function replicateKeyringBlob(
  keyringId: string,
  cardHash: string,
  encryptedBlob: string
): Promise<void> {
  const config = loadConfig();
  const message = buildSignedKeyringMessage(
    { keyring_id: keyringId, card_hash: cardHash, encrypted_blob: encryptedBlob },
    config.WALLET_SERVICE_ID,
    privateKeyBytes(config)
  );
  await broadcastKeyring(message);
}

export async function replicateKeyringDelete(keyringId: string): Promise<void> {
  const config = loadConfig();
  const message = buildSignedKeyringDeleteMessage(
    { keyring_id: keyringId },
    config.WALLET_SERVICE_ID,
    privateKeyBytes(config)
  );
  await broadcastKeyringDelete(message);
}
