// POST /deliver/{uuid} — relay.md §7.2, relay_data_model.md §10.3
// "Delivering a message."
//
// Two-step, non-atomic flow, exactly as §10.3 specifies:
//   Step 1 (Redis): unused -> in_flight -> consumed, store blob. Unchanged
//   by this migration, does not involve the DO at all.
//   Step 2 (DO check, only after step 1 durably succeeds): ask the relevant
//   DO whether it holds an open connection; if so, deliver directly and
//   skip push. If not, fall back to push. Step 2's outcome never changes
//   step 1's Redis transition or the blob's already-durable storage.
//
// Delivery priority per relay.md §7.2 step 7: SSE (device_credential-keyed
// DeviceChannel DO) first, then WebSocket (uuid-keyed UuidConnection DO),
// then silent push.
//
// Staggered-delete scheduling differs by channel (§7.2 step 7, verbatim):
//   - SSE:  "Do not remove from message store yet — wait for POST /ack."
//           No delete-queue enqueue happens here; server/api/ack.post.ts
//           enqueues it once the device explicitly acks.
//   - WS:   "forward blob. Schedule staggered delete on delivery."
//           The delete-queue enqueue happens immediately, right here, as
//           part of this same request — there is no separate ack step for
//           the WS channel.
// Both rules are implemented in do-client.ts's attemptLiveDelivery(), which
// this handler delegates to so the branching logic has a single, tested
// home (see server/do/live-delivery.do-test.ts).

import { readBody, type H3Event } from 'h3';
import { relayError } from '../../utils/http-errors';
import { createRedisClientForRequest } from '../../utils/redis/client-factory';
import { UuidStore } from '../../utils/redis/uuid-store';
import { MessageStore } from '../../utils/redis/message-store';
import { DeleteQueue } from '../../utils/redis/delete-queue';
import { isValidUuidV4, nowIso } from '../../utils/ids';
import { attemptLiveDelivery } from '../../utils/do-client';
import { dispatchPush } from '../../utils/push/dispatch';
import { loadAppRegistry } from '../../utils/app-registry';
import { getEnvInt } from '../../utils/env';

interface DeliverBody {
  blob?: string;
}

export default defineEventHandler(async (event: H3Event) => {
  const uuid = event.context.params?.uuid;
  if (!uuid || !isValidUuidV4(uuid)) {
    throw relayError('INVALID_UUID', 'Path parameter is not a valid UUID v4');
  }

  const body = await readBody<DeliverBody>(event);
  if (!body?.blob) {
    throw relayError('MISSING_FIELD', 'blob is required');
  }

  const redis = createRedisClientForRequest(event);
  try {
    const uuidStore = new UuidStore(redis);
    const messageStore = new MessageStore(redis);

    const record = await uuidStore.get(uuid);
    if (!record) {
      throw relayError('UNKNOWN_UUID', 'UUID not found');
    }
    if (record.status !== 'unused') {
      throw relayError('UUID_CONSUMED', `UUID is ${record.status}`);
    }

    // Step 1a: unused -> in_flight (relay.md §7.2 step 4).
    const lockResult = await uuidStore.casTransition(uuid, 'unused', 'in_flight');
    if (!lockResult.ok) {
      throw relayError('UUID_CONSUMED', 'Concurrent delivery race lost');
    }

    try {
      // Step 1b: store the blob durably (relay.md §7.2 step 5).
      await messageStore.append(record.device_credential, {
        uuid,
        blob: body.blob,
        wallet_url: record.wallet_base_url,
        received_at: nowIso(),
      });

      // Step 1c: in_flight -> consumed (relay.md §7.2 step 6). Blob is
      // durably stored regardless of what step 2 (DO check) finds below —
      // this is the at-least-once guarantee §10.3 step 3 describes.
      await uuidStore.casTransition(uuid, 'in_flight', 'consumed');
    } catch (err) {
      // Storage failure: roll back to unused (relay.md §7.2 "On storage
      // failure").
      await uuidStore.casTransition(uuid, 'in_flight', 'unused').catch(() => {
        // Best-effort rollback; if this also fails the UUID is left
        // in_flight and will be caught by the reconciliation scan
        // (relay_data_model.md §2.5/§7.3's "in_flight -> consumed" scan
        // transition) — logged, not re-thrown, since we're already in an
        // error path and the original error is what should surface.
      });
      throw relayError('INTERNAL_ERROR', 'Redis failure while storing message');
    }

    // Step 2 (DO check — happens ONLY after step 1 durably succeeded, per
    // §10.3's explicit ordering): try SSE first, then WS, then push. The
    // WS branch additionally schedules the staggered delete immediately on
    // delivery (§7.2 step 7); the SSE branch does not (waits for POST
    // /ack instead) — see attemptLiveDelivery's doc comment in do-client.ts.
    const message = { uuid, blob: body.blob };
    const maxDelaySeconds = getEnvInt(event, 'MAX_DELETE_DELAY_SECONDS', 21_600);
    const deleteQueue = new DeleteQueue(redis, maxDelaySeconds);

    const liveResult = await attemptLiveDelivery(event, uuid, record, message, async () => {
      await deleteQueue.enqueue(record.wallet_base_url, uuid, Math.floor(Date.now() / 1000));
    });
    if (liveResult.delivered) {
      return {};
    }

    // Neither channel had a live connection — fall back to silent push
    // (relay.md §7.2 step 7's final else branch).
    const appRegistry = await loadAppRegistry(event);
    const app = appRegistry.get(record.app_id);
    if (app) {
      await dispatchPush(event, app, record.push_token, { uuid });
    }

    return {};
  } finally {
    await redis.close();
  }
});
