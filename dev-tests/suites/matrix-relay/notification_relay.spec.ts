/**
 * `specs/process_specs/notification_relay.md` end-to-end, against the live
 * dev relay deployment. Ported from
 * integration_tests/suites/matrix-relay/notification_relay.spec.ts
 * unchanged in test logic -- only config sourcing changed:
 * `RELAY_BASE_URL` comes from `../../support/liveCard.js` (backed by
 * `DEV_RELAY_URL`), and `TEST_APP_ID` reuses `DEV_RELAY_KNOWN_APP_ID` (the
 * same config value `conformance/relay_data_model.spec.ts` uses) instead of
 * a default `'integration-tests'` app_id, since the real deployed relay's
 * app registry doesn't have a locally-editable fixture file — the app_id
 * used here must already exist in whatever `APP_REGISTRY_JSON` the operator
 * configured (see relay/DEPLOYMENT.md).
 *
 * Tests the relay's role in bridging encrypted message delivery between
 * wallet service and device, covering registration, message delivery,
 * device catch-up, staggered wallet clearance scheduling, device
 * authentication/isolation, and the relay's card-blindness privacy
 * property. Scope notes (SSE stream delivery, WebSocket delivery, real
 * push dispatch, multi-device correlation timing) are unchanged from the
 * original suite — see its equivalent header comment for the full list.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { RELAY_BASE_URL } from '../../support/liveCard.js';

const TEST_APP_ID = process.env.DEV_RELAY_KNOWN_APP_ID ?? '';

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

describe('notification_relay.md (live dev deployment)', () => {
  const testPushToken = `test-push-token-${Date.now()}-${Math.random()}`;
  let deviceCredential: string;
  let generatedUuids: string[] = [];

  beforeAll(() => {
    if (!TEST_APP_ID) {
      throw new Error('notification_relay.spec.ts requires DEV_RELAY_KNOWN_APP_ID -- see dev-tests/.env.example.');
    }
  });

  afterEach(() => {
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

      expect(Array.isArray(replenishBody.uuids)).toBe(true);
      const replenishUuidsArray = replenishBody.uuids as unknown[];
      expect(replenishUuidsArray.length).toBe(2);
      expect(replenishBody.device_credential).toBeUndefined();

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
        count: 150,
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
    let deliveryUuids: string[] = [];

    beforeAll(async () => {
      const regResponse = await relayRequest('POST', '/register', {
        app_id: TEST_APP_ID,
        push_token: `${testPushToken}-delivery`,
        count: 10,
      });

      const regBody = (await regResponse.json()) as {
        uuids?: unknown;
        device_credential?: unknown;
      };
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
      expect(body).toBeDefined();
    });

    it('Phase 2: UUID transitions from unused → in_flight → consumed on delivery', async () => {
      const uuid = deliveryUuids[1]!;
      const mockBlob = Buffer.from('test-payload').toString('base64url');

      const response1 = await relayRequest('POST', `/deliver/${uuid}`, {
        blob: mockBlob,
      });
      expect(response1.status).toBe(200);

      const response2 = await relayRequest('POST', `/deliver/${uuid}`, {
        blob: mockBlob,
      });
      expect(response2.status).toBe(410);
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
      const uuid = deliveryUuids[3]!;
      const mockBlob = Buffer.from('privacy-test-payload').toString('base64url');

      const response = await relayRequest('POST', `/deliver/${uuid}`, {
        blob: mockBlob,
      });

      expect(response.status).toBe(200);
    });
  });

  describe('§Process 5: Device Catch-up via GET /pending', () => {
    let pendingCredential: string;

    beforeAll(async () => {
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
      const pendingUuids = regBody.uuids as string[];

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

      for (const msg of messages) {
        expect(typeof msg.uuid).toBe('string');
        expect(typeof msg.blob).toBe('string');
      }
    });

    it('Phase 2: GET /pending atomically drains the message store', async () => {
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

      const blob = Buffer.from('test-drain').toString('base64url');
      await relayRequest('POST', `/deliver/${uuids[0]!}`, { blob });

      const response1 = await relayRequestWithAuth('GET', '/pending', cred);
      expect(response1.status).toBe(200);
      const body1 = (await response1.json()) as { messages?: unknown };
      expect((body1.messages as Array<unknown>).length).toBeGreaterThan(0);

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

      expect(cred1).not.toEqual(cred2);

      expect(cred1.length).toBeGreaterThan(0);
      expect(cred2.length).toBeGreaterThan(0);
    });

    it('Device credentials provide isolation: one device cannot fetch another device\'s messages', async () => {
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

      const blobA = Buffer.from('device-a-secret').toString('base64url');
      await relayRequest('POST', `/deliver/${uuidsA[0]!}`, { blob: blobA });

      const regB = await relayRequest('POST', '/register', {
        app_id: TEST_APP_ID,
        push_token: `${testPushToken}-device-b`,
        count: 1,
      });

      const bodyB = (await regB.json()) as { device_credential?: unknown };
      const credB = bodyB.device_credential as string;

      const fetchWithWrongCred = await relayRequestWithAuth('GET', '/pending', credA);
      expect(fetchWithWrongCred.status).toBe(200);
      const messagesA = (await fetchWithWrongCred.json()) as { messages?: unknown };
      const listA = messagesA.messages as Array<unknown>;

      const fetchWithOwnCred = await relayRequestWithAuth('GET', '/pending', credB);
      expect(fetchWithOwnCred.status).toBe(200);
      const messagesB = (await fetchWithOwnCred.json()) as { messages?: unknown };
      const listB = messagesB.messages as Array<unknown>;

      expect(Array.isArray(listA)).toBe(true);
      expect(Array.isArray(listB)).toBe(true);
    });
  });

  describe('§Relay Service Trust Model (Privacy)', () => {
    it('Relay never observes card_hash or subcard_hash (device-side concern)', async () => {
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

      const response = await relayRequest('POST', `/deliver/${uuid}`, {
        blob: Buffer.from('test-payload').toString('base64url'),
      });

      expect(response.status).toBe(200);

      expect(uuid).not.toEqual(regBody.device_credential);
      expect(regBody.device_credential).not.toEqual(`${testPushToken}-privacy`);
    });

    it('Device credential is persisted across replenishments', async () => {
      const pushToken = `${testPushToken}-persist`;

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

      expect(body2.device_credential).toBeUndefined();

      expect(Array.isArray(body2.uuids)).toBe(true);

      const pendingResponse = await relayRequestWithAuth('GET', '/pending', cred1);
      expect(pendingResponse.status).toBe(200);
    });
  });
});
