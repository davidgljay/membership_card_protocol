/**
 * Peer fan-out for federation messages (implementation-plan.md §Step 4.1
 * `broadcastAnnouncement`, §Step 4.1a `broadcastKeyring`/`broadcastKeyringDelete`).
 * Best-effort: a peer being unreachable doesn't fail the caller's request —
 * the peer will catch up via startup sync (`GET /bindings`) or a later
 * announcement. Failures are logged, not retried (no durable queue here,
 * unlike notification_jobs — binding state is eventually consistent by
 * design per message_routing.md).
 */

import { loadConfig } from '../../src/config.js';
import type { AnnouncementEnvelope } from '../../src/federation/binding.js';
import type { SignedKeyringMessage, SignedKeyringDeleteMessage } from '../../src/federation/keyring-sync.js';

async function postToAllPeers(path: string, body: unknown): Promise<void> {
  const config = loadConfig();
  await Promise.all(
    config.PEER_LIST.map(async (peer) => {
      try {
        const res = await fetch(`${peer.endpoint}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          console.warn(`[wallet-service] broadcast to ${peer.wallet_service_id} failed: HTTP ${res.status}`);
        }
      } catch (err) {
        console.warn(`[wallet-service] broadcast to ${peer.wallet_service_id} failed: ${String(err)}`);
      }
    })
  );
}

export async function broadcastAnnouncement(envelope: AnnouncementEnvelope): Promise<void> {
  await postToAllPeers('/bindings/announce', envelope);
}

export async function broadcastKeyring(message: SignedKeyringMessage): Promise<void> {
  await postToAllPeers('/federation/keyrings', message);
}

export async function broadcastKeyringDelete(message: SignedKeyringDeleteMessage): Promise<void> {
  await postToAllPeers('/federation/keyrings/delete', message);
}
