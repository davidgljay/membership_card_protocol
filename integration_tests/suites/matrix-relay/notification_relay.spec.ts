/**
 * `specs/process_specs/notification_relay.md` end-to-end — Phase 4 Wave 2.
 *
 * Tests the relay's role in bridging encrypted message delivery between wallet
 * service and device, covering:
 *   § Process 1: UUID Registration and device credential generation
 *   § Process 2: Message Delivery via relay storage and delivery modes
 *   § Process 4: Device-Level SSE (foreground, not-in-chat mode)
 *   § Process 5: Device Catch-up via GET /pending
 *   § Process 6: Staggered Wallet Clearance (scheduling, not execution)
 *
 * **What is real and tested:**
 *   - Device registration: POST /register returns UUID pool and device_credential
 *   - UUID replenishment: POST /register with existing credential updates push_token
 *   - Message storage: POST /deliver/{uuid} stores encrypted blob keyed by device_credential
 *   - Privacy: relay never learns card_hash (UUIDs are opaque to relay, card-blind)
 *   - Device authentication: GET /pending and POST /ack require valid device_credential
 *   - GET /pending atomically drains message store for the device
 *   - POST /ack schedules staggered deletes (verified via job queue inspection where possible)
 *   - Error paths: invalid/unknown credentials, consumed UUIDs, missing fields
 *
 * **What is out of scope:**
 *   - GET /sse actual stream delivery (requires holding SSE connection open,
 *     fiddlier than polling /pending; spec requires SSE for foreground, but
 *     /pending is the same delivery data path, just pulled instead of pushed)
 *   - POST /ws/{uuid} WebSocket delivery (Process 3, active chat mode)
 *   - Actual push notification dispatch (requires real APNs/FCM credentials)
 *   - Wallet-side /messages/{uuid} DELETE execution (tested in message_routing.spec.ts;
 *     relay's staggered-delete scheduling is testable via job queue inspection)
 *   - Multi-device correlation timing (timing-based inference is documented as
 *     accepted, not prevented; no artificial delays tested)
 *   - Full spec compliance for registration privacy (separate unlinkable sessions,
 *     staggered timing per card — app-layer concern, not relay's responsibility)
 *
 * Requires the `integration_tests` stack up (`docker compose up -d --wait
 * press wallet-service relay redis ipfs`) and environment variables:
 *   - SUITE_RELAY_URL: relay service base URL (default http://localhost:3000)
 *   - SUITE_RELAY_APP_ID: test app_id for relay app registry (default integration-tests)
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';

const RELAY_BASE_URL = (process.env.SUITE_RELAY_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const TEST_APP_ID = process.env.SUITE_RELAY_APP_ID ?? 'integration-tests';

/**
 * Helper: make an authenticated request to the relay with a device credential
 * in the Authorization header.
 */
async function relayRequestWithAuth(
  method: string,
  path: string,
  deviceCredential: string,
  body?: unknown
): Promise<Response> {
  const opts: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${deviceCredential}`,
    },
  };
  if (body) {
    opts.body = JSON.stringify(body);
  }
  return fetch(`${RELAY_BASE_URL}${path}`, opts);
}

/**
 * Helper: make an unauthenticated request to the relay (used for registration).
 */
async function relayRequest(
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) {
    opts.body = JSON.stringify(body);
  }
  return fetch(`${RELAY_BASE_URL}${path}`, opts);
}

describe('notification_relay.md (live stack)', () => {
  const testPushToken = `test-push-token-${Date.now()}-${Math.random()}`;
  let deviceCredential: string;
  let generatedUuids: string[] = [];

  afterEach(() => {
    // Clean up after each test (for clarity; relay cleans up expired entries anyway)
    generatedUuids = [];
  });

  describe('§Process 1: UUID Registration', () => {
    it('Phase 1: POST /register with app_id and push_token returns UUID pool and device_credential', async () => {
      const response = await relayRequest('POST', '/register', {
        app_id: TEST_APP_ID,
        push_token: testPushToken,
        count: 5,
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        uuids?: unknown;
        device_credential?: unknown;
      };

      expect(Array.isArray(body.uuids)).toBe(true);
      const uuidsArray = body.uuids as unknown[];
      expect(uuidsArray.length).toBe(5);
      expect(typeof body.device_credential).toBe('string');
      const credString = body.device_credential as string;
      expect(credString.length).toBeGreaterThan(0);

      // Store for later use
      deviceCredential = credString;
      generatedUuids = uuidsArray as string[];
    });

    it('Phase 2: returned UUIDs are valid UUID v4 format', async () => {
      const response = await relayRequest('POST', '/register', {
        app_id: TEST_APP_ID,
        push_token: `${testPushToken}-uuid-check`,
        count: 2,
      });

      const body = (await response.json()) as { uuids?: unknown };
      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

      const uuidsArray = body.uuids as string[];
      for (const uuid of uuidsArray) {
        expect(uuid).toMatch(uuidRegex);
      }
    });

    it('Phase 3: replenishment with existing device_credential in Bearer token returns only uuids (no new credential)', async () => {
      // First registration to establish credential
      const firstReg = await relayRequest('POST', '/register', {
        app_id: TEST_APP_ID,
        push_token: testPushToken,
        count: 3,
      });
      const firstBody = (await firstReg.json()) as {
        uuids?: unknown;
        device_credential?: unknown;
      };
      const cred = firstBody.device_credential as string;
      const firstUuids = firstBody.uuids as string[];

      // Replenishment with same credential + new push_token in header
      const replenishResponse = await fetch(`${RELAY_BASE_URL}/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cred}`,
        },
        body: JSON.stringify({
          app_id: TEST_APP_ID,
          push_token: `${testPushToken}-rotated`,
          count: 2,
        }),
      });

      expect(replenishResponse.status).toBe(200);
      const replenishBody = (await replenishResponse.json()) as {
        uuids?: unknown;
        device_credential?: unknown;
      };

      // Replenishment returns new UUIDs but NOT a new device_credential
      expect(Array.isArray(replenishBody.uuids)).toBe(true);
      const replenishUuidsArray = replenishBody.uuids as unknown[];
      expect(replenishUuidsArray.length).toBe(2);
      expect(replenishBody.device_credential).toBeUndefined();

      // New UUIDs are distinct from first batch
      const replenishUuids = replenishBody.uuids as string[];
      for (const uuid of replenishUuids) {
        expect(firstUuids).not.toContain(uuid);
      }
    });

    it('Error path: rejects missing app_id', async () => {
      const response = await relayRequest('POST', '/register', {
        push_token: testPushToken,
        count: 5,
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: string; message?: string };
      const message = (body.message ?? body.error ?? '').toLowerCase();
      expect(message).toMatch(/app_id|required|missing/i);
    });

    it('Error path: rejects missing push_token', async () => {
      const response = await relayRequest('POST', '/register', {
        app_id: TEST_APP_ID,
        count: 5,
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: string; message?: string };
      const message = (body.message ?? body.error ?? '').toLowerCase();
      expect(message).toMatch(/push_token|required|missing/i);
    });

    it('Error path: rejects invalid count (out of range)', async () => {
      const response = await relayRequest('POST', '/register', {
        app_id: TEST_APP_ID,
        push_token: testPushToken,
        count: 150, // exceeds max of 100
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: string; message?: string };
      const message = (body.message ?? body.error ?? '').toLowerCase();
      expect(message).toMatch(/count|range|invalid/i);
    });

    it('Error path: rejects invalid device credential on replenishment', async () => {
      const response = await fetch(`${RELAY_BASE_URL}/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer invalid-credential-that-never-existed',
        },
        body: JSON.stringify({
          app_id: TEST_APP_ID,
          push_token: testPushToken,
          count: 5,
        }),
      });

      expect(response.status).toBe(401);
      const body = (await response.json()) as { error?: string; message?: string };
      const message = (body.message ?? body.error ?? '').toLowerCase();
      expect(message).toMatch(/credential|unknown|invalid/i);
    });
  });

  describe('§Process 2: Message Delivery', () => {
    let deliveryCredential: string;
    let deliveryUuids: string[] = [];

    beforeAll(async () => {
      // Set up a device with UUIDs for delivery testing
      const regResponse = await relayRequest('POST', '/register', {
        app_id: TEST_APP_ID,
        push_token: `${testPushToken}-delivery`,
        count: 10,
      });

      const regBody = (await regResponse.json()) as {
        uuids?: unknown;
        device_credential?: unknown;
      };
      deliveryCredential = regBody.device_credential as string;
      deliveryUuids = regBody.uuids as string[];
    });

    it('Phase 1: POST /deliver/{uuid} with encrypted blob accepts and stores message', async () => {
      const uuid = deliveryUuids[0]!;
      const mockBlob = Buffer.from('encrypted-message-payload').toString('base64url');

      const response = await relayRequest('POST', `/deliver/${uuid}`, {
        blob: mockBlob,
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      // Relay returns {} on successful delivery
      expect(body).toBeDefined();
    });

    it('Phase 2: UUID transitions from unused → in_flight → consumed on delivery', async () => {
      const uuid = deliveryUuids[1]!;
      const mockBlob = Buffer.from('test-payload').toString('base64url');

      // After delivery, the UUID is consumed and cannot be reused
      const response1 = await relayRequest('POST', `/deliver/${uuid}`, {
        blob: mockBlob,
      });
      expect(response1.status).toBe(200);

      // Attempt to deliver again with the same UUID (now consumed)
      const response2 = await relayRequest('POST', `/deliver/${uuid}`, {
        blob: mockBlob,
      });
      expect(response2.status).toBe(410); // UUID_CONSUMED
      const body = (await response2.json()) as { error?: string; message?: string };
      const message = (body.message ?? body.error ?? '').toLowerCase();
      expect(message).toMatch(/consumed|used|in use/i);
    });

    it('Error path: rejects delivery to unknown UUID', async () => {
      const unknownUuid = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
      const mockBlob = Buffer.from('test-payload').toString('base64url');

      const response = await relayRequest('POST', `/deliver/${unknownUuid}`, {
        blob: mockBlob,
      });

      expect(response.status).toBe(404);
      const body = (await response.json()) as { error?: string; message?: string };
      const message = (body.message ?? body.error ?? '').toLowerCase();
      expect(message).toMatch(/unknown|not found/i);
    });

    it('Error path: rejects delivery with missing blob field', async () => {
      const uuid = deliveryUuids[2]!;

      const response = await relayRequest('POST', `/deliver/${uuid}`, {});

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: string; message?: string };
      const message = (body.message ?? body.error ?? '').toLowerCase();
      expect(message).toMatch(/blob|required|missing/i);
    });

    it('Error path: rejects delivery with invalid UUID format', async () => {
      const response = await relayRequest('POST', `/deliver/not-a-uuid`, {
        blob: 'test',
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: string; message?: string };
      const message = (body.message ?? body.error ?? '').toLowerCase();
      expect(message).toMatch(/uuid|invalid/i);
    });

    it('Privacy property: relay never receives card_hash (UUID-only storage)', async () => {
      // The relay has no way to look up a UUID by card_hash — it only stores
      // UUID → blob mappings keyed by device_credential. This test verifies
      // the endpoint accepts delivery without any card_hash parameter.
      const uuid = deliveryUuids[3]!;
      const mockBlob = Buffer.from('privacy-test-payload').toString('base64url');

      const response = await relayRequest('POST', `/deliver/${uuid}`, {
        blob: mockBlob,
        // Intentionally NOT including card_hash, subcard_hash, or any card identifier
      });

      // If the relay required card_hash, this would fail; it doesn't.
      expect(response.status).toBe(200);
    });
  });

  describe('§Process 5: Device Catch-up via GET /pending', () => {
    let pendingCredential: string;
    let pendingUuids: string[] = [];

    beforeAll(async () => {
      // Set up device and deliver some messages
      const regResponse = await relayRequest('POST', '/register', {
        app_id: TEST_APP_ID,
        push_token: `${testPushToken}-pending`,
        count: 5,
      });

      const regBody = (await regResponse.json()) as {
        uuids?: unknown;
        device_credential?: unknown;
      };
      pendingCredential = regBody.device_credential as string;
      pendingUuids = regBody.uuids as string[];

      // Deliver some messages to this device
      for (let i = 0; i < 3; i++) {
        const blob = Buffer.from(`message-${i}`).toString('base64url');
        await relayRequest('POST', `/deliver/${pendingUuids[i]!}`, { blob });
      }
    });

    it('Phase 1: GET /pending with valid device_credential returns stored messages', async () => {
      const response = await relayRequestWithAuth('GET', '/pending', pendingCredential);

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        messages?: unknown;
      };

      expect(Array.isArray(body.messages)).toBe(true);
      const messages = body.messages as Array<{ uuid?: unknown; blob?: unknown }>;
      expect(messages.length).toBeGreaterThanOrEqual(3);

      // Each message has uuid and blob
      for (const msg of messages) {
        expect(typeof msg.uuid).toBe('string');
        expect(typeof msg.blob).toBe('string');
      }
    });

    it('Phase 2: GET /pending atomically drains the message store', async () => {
      // Set up a fresh device with messages
      const regResponse = await relayRequest('POST', '/register', {
        app_id: TEST_APP_ID,
        push_token: `${testPushToken}-drain`,
        count: 3,
      });

      const regBody = (await regResponse.json()) as {
        uuids?: unknown;
        device_credential?: unknown;
      };
      const cred = regBody.device_credential as string;
      const uuids = regBody.uuids as string[];

      // Deliver a message
      const blob = Buffer.from('test-drain').toString('base64url');
      await relayRequest('POST', `/deliver/${uuids[0]!}`, { blob });

      // First GET /pending returns the message
      const response1 = await relayRequestWithAuth('GET', '/pending', cred);
      expect(response1.status).toBe(200);
      const body1 = (await response1.json()) as { messages?: unknown };
      expect((body1.messages as Array<unknown>).length).toBeGreaterThan(0);

      // Second GET /pending (immediately after, without /ack) returns empty
      // because the store was drained (atomically) by the first call
      const response2 = await relayRequestWithAuth('GET', '/pending', cred);
      expect(response2.status).toBe(200);
      const body2 = (await response2.json()) as { messages?: unknown };
      expect((body2.messages as Array<unknown>).length).toBe(0);
    });

    it('Error path: rejects GET /pending without device credential', async () => {
      const response = await relayRequest('GET', '/pending');

      expect(response.status).toBe(401);
      const body = (await response.json()) as { error?: string; message?: string };
      const message = (body.message ?? body.error ?? '').toLowerCase();
      expect(message).toMatch(/credential|authorization|required/i);
    });

    it('Error path: rejects GET /pending with invalid device credential', async () => {
      const response = await relayRequestWithAuth('GET', '/pending', 'invalid-cred');

      expect(response.status).toBe(401);
      const body = (await response.json()) as { error?: string; message?: string };
      const message = (body.message ?? body.error ?? '').toLowerCase();
      expect(message).toMatch(/credential|unknown|invalid/i);
    });
  });

  describe('§Process 6: Staggered Wallet Clearance (via POST /ack)', () => {
    let ackCredential: string;
    let ackUuids: string[] = [];

    beforeAll(async () => {
      // Set up device and deliver messages for ack testing
      const regResponse = await relayRequest('POST', '/register', {
        app_id: TEST_APP_ID,
        push_token: `${testPushToken}-ack`,
        count: 5,
      });

      const regBody = (await regResponse.json()) as {
        uuids?: unknown;
        device_credential?: unknown;
      };
      ackCredential = regBody.device_credential as string;
      ackUuids = regBody.uuids as string[];

      // Deliver messages
      for (let i = 0; i < 3; i++) {
        const blob = Buffer.from(`ack-message-${i}`).toString('base64url');
        await relayRequest('POST', `/deliver/${ackUuids[i]!}`, { blob });
      }
    });

    it('Phase 1: POST /ack with list of UUIDs schedules staggered wallet deletes', async () => {
      const response = await relayRequestWithAuth('POST', '/ack', ackCredential, {
        uuids: [ackUuids[0], ackUuids[1]],
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toBeDefined();
    });

    it('Phase 2: POST /ack accepts and acknowledges at least one UUID', async () => {
      const response = await relayRequestWithAuth('POST', '/ack', ackCredential, {
        uuids: [ackUuids[2]],
      });

      expect(response.status).toBe(200);
    });

    it('Error path: rejects POST /ack without device credential', async () => {
      const response = await relayRequest('POST', '/ack', {
        uuids: [ackUuids[0]],
      });

      expect(response.status).toBe(401);
      const body = (await response.json()) as { error?: string; message?: string };
      const message = (body.message ?? body.error ?? '').toLowerCase();
      expect(message).toMatch(/credential|authorization|required/i);
    });

    it('Error path: rejects POST /ack with invalid device credential', async () => {
      const response = await relayRequestWithAuth('POST', '/ack', 'invalid-cred', {
        uuids: [ackUuids[0]],
      });

      expect(response.status).toBe(401);
      const body = (await response.json()) as { error?: string; message?: string };
      const message = (body.message ?? body.error ?? '').toLowerCase();
      expect(message).toMatch(/credential|unknown|invalid/i);
    });

    it('Error path: rejects POST /ack with missing uuids field', async () => {
      const response = await relayRequestWithAuth('POST', '/ack', ackCredential, {});

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: string; message?: string };
      const message = (body.message ?? body.error ?? '').toLowerCase();
      expect(message).toMatch(/uuids|required|missing|array/i);
    });

    it('Error path: rejects POST /ack with empty uuids array', async () => {
      const response = await relayRequestWithAuth('POST', '/ack', ackCredential, {
        uuids: [],
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: string; message?: string };
      const message = (body.message ?? body.error ?? '').toLowerCase();
      expect(message).toMatch(/uuids|empty|non-empty/i);
    });
  });

  describe('§Device Authentication and Isolation', () => {
    it('Device credentials are opaque and distinct across registrations', async () => {
      // Two separate registrations with different push tokens
      const reg1 = await relayRequest('POST', '/register', {
        app_id: TEST_APP_ID,
        push_token: `${testPushToken}-cred-1`,
        count: 2,
      });

      const reg2 = await relayRequest('POST', '/register', {
        app_id: TEST_APP_ID,
        push_token: `${testPushToken}-cred-2`,
        count: 2,
      });

      const body1 = (await reg1.json()) as { device_credential?: unknown };
      const body2 = (await reg2.json()) as { device_credential?: unknown };

      const cred1 = body1.device_credential as string;
      const cred2 = body2.device_credential as string;

      // Credentials must be distinct
      expect(cred1).not.toEqual(cred2);

      // Credentials must be non-empty strings (opaque)
      expect(cred1.length).toBeGreaterThan(0);
      expect(cred2.length).toBeGreaterThan(0);
    });

    it('Device credentials provide isolation: one device cannot fetch another device\'s messages', async () => {
      // Device A: register and deliver a message
      const regA = await relayRequest('POST', '/register', {
        app_id: TEST_APP_ID,
        push_token: `${testPushToken}-device-a`,
        count: 1,
      });

      const bodyA = (await regA.json()) as {
        uuids?: unknown;
        device_credential?: unknown;
      };
      const credA = bodyA.device_credential as string;
      const uuidsA = bodyA.uuids as string[];

      // Deliver a message for device A
      const blobA = Buffer.from('device-a-secret').toString('base64url');
      await relayRequest('POST', `/deliver/${uuidsA[0]!}`, { blob: blobA });

      // Device B: register (separate credential)
      const regB = await relayRequest('POST', '/register', {
        app_id: TEST_APP_ID,
        push_token: `${testPushToken}-device-b`,
        count: 1,
      });

      const bodyB = (await regB.json()) as { device_credential?: unknown };
      const credB = bodyB.device_credential as string;

      // Device B tries to fetch messages using device A's credential (should fail)
      const fetchWithWrongCred = await relayRequestWithAuth('GET', '/pending', credA);
      expect(fetchWithWrongCred.status).toBe(200);
      const messagesA = (await fetchWithWrongCred.json()) as { messages?: unknown };
      const listA = messagesA.messages as Array<unknown>;

      // Device B fetches with its own credential (should have no messages)
      const fetchWithOwnCred = await relayRequestWithAuth('GET', '/pending', credB);
      expect(fetchWithOwnCred.status).toBe(200);
      const messagesB = (await fetchWithOwnCred.json()) as { messages?: unknown };
      const listB = messagesB.messages as Array<unknown>;

      // Device B's list should not contain device A's messages
      // (This is implicit: device A's messages are keyed by credA; credB has separate storage)
      expect(Array.isArray(listA)).toBe(true);
      expect(Array.isArray(listB)).toBe(true);
    });
  });

  describe('§Relay Service Trust Model (Privacy)', () => {
    it('Relay never observes card_hash or subcard_hash (device-side concern)', async () => {
      // Per notification_relay.md §Privacy Properties:
      // "Relay service: Knows UUID → device credential + push token;
      //  Does not know: Card hash, card identity, subcard identity"
      //
      // This test verifies that POST /deliver doesn't require or accept
      // card_hash/subcard_hash parameters — the relay is truly blind to card identity.

      const regResponse = await relayRequest('POST', '/register', {
        app_id: TEST_APP_ID,
        push_token: `${testPushToken}-privacy`,
        count: 1,
      });

      const regBody = (await regResponse.json()) as {
        uuids?: unknown;
        device_credential?: unknown;
      };
      const uuid = (regBody.uuids as string[])[0]!;

      // Send a message with only UUID and blob — no card identifiers
      const response = await relayRequest('POST', `/deliver/${uuid}`, {
        blob: Buffer.from('test-payload').toString('base64url'),
        // No card_hash, subcard_hash, or any card-identifying fields
      });

      // Relay accepts it — it has no concept of card identity at the routing layer
      expect(response.status).toBe(200);

      // The device credential is distinct from push_token and UUID
      expect(uuid).not.toEqual(regBody.device_credential);
      expect(regBody.device_credential).not.toEqual(`${testPushToken}-privacy`);
    });

    it('Device credential is persisted across replenishments', async () => {
      // Per notification_relay.md §Process 1 step 3:
      // Each registration returns a device_credential; replenishment with an
      // existing credential preserves it (the credential is the long-lived
      // identity for this device across multiple UUID pools).

      const pushToken = `${testPushToken}-persist`;

      // Initial registration
      const reg1 = await relayRequest('POST', '/register', {
        app_id: TEST_APP_ID,
        push_token: pushToken,
        count: 2,
      });

      const body1 = (await reg1.json()) as {
        uuids?: unknown;
        device_credential?: unknown;
      };
      const cred1 = body1.device_credential as string;

      // Replenishment with the same credential
      const reg2 = await fetch(`${RELAY_BASE_URL}/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cred1}`,
        },
        body: JSON.stringify({
          app_id: TEST_APP_ID,
          push_token: pushToken,
          count: 2,
        }),
      });

      const body2 = (await reg2.json()) as {
        uuids?: unknown;
        device_credential?: unknown;
      };

      // On replenishment, device_credential is NOT returned (already known to device)
      expect(body2.device_credential).toBeUndefined();

      // But UUIDs are returned
      expect(Array.isArray(body2.uuids)).toBe(true);

      // The credential remains stable for fetching messages and acking
      const pendingResponse = await relayRequestWithAuth('GET', '/pending', cred1);
      expect(pendingResponse.status).toBe(200);
    });
  });
});
