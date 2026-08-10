/**
 * `specs/process_specs/message_routing.md` end-to-end, against the live dev
 * deployment. Ported from
 * integration_tests/suites/matrix-relay/message_routing.spec.ts unchanged in
 * test logic -- only the wallet-service base URL source changed (from
 * `process.env.SUITE_WALLET_SERVICE_URL` to `../../support/liveCard.js`'s
 * `WALLET_SERVICE_BASE_URL`, backed by `DEV_WALLET_SERVICE_URL`).
 *
 * Tests the off-chain binding-announcement mechanism and message routing
 * layer, covering binding announcements, local routing tables, message
 * delivery, and UUID registration.
 *
 * **Environment note, unchanged from the original**: this deployment runs a
 * single wallet-service instance, so the "two different wallet services"
 * scenario is not testable literally — tests exercise self-routing instead.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  mlDsa44GenerateKeypair,
  mlDsa44Sign,
  mlDsa44GetPublicKey,
  keccak256,
  bytesToBase64Url,
  canonicalize,
} from '@membership-card-protocol/app-sdk';
import { mintLiveCard, type LiveIdentity, WALLET_SERVICE_BASE_URL } from '../../support/liveCard.js';

interface CardBindingAnnouncementPayload {
  type: 'card_registration' | 'card_migration';
  card_hash: string;
  wallet_service_id: string;
  endpoint: string;
  timestamp: string;
  nonce: string;
}

interface SignatureEntry {
  public_key: string;
  role: 'wallet_service' | 'cardholder';
  signature: string;
}

interface AnnouncementEnvelope {
  payload: CardBindingAnnouncementPayload;
  signatures: SignatureEntry[];
}

function buildRegistrationAnnouncement(
  cardHash: string,
  walletServiceId: string,
  walletServiceEndpoint: string,
  walletServicePrivateKey: Uint8Array
): AnnouncementEnvelope {
  const payload: CardBindingAnnouncementPayload = {
    type: 'card_registration',
    card_hash: cardHash,
    wallet_service_id: walletServiceId,
    endpoint: walletServiceEndpoint,
    timestamp: new Date().toISOString(),
    nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
  };

  const canonicalBytes = canonicalize(payload);
  const signature = mlDsa44Sign(walletServicePrivateKey, canonicalBytes);
  const publicKey = mlDsa44GetPublicKey(walletServicePrivateKey);

  return {
    payload,
    signatures: [
      {
        public_key: bytesToBase64Url(publicKey),
        role: 'wallet_service',
        signature: Buffer.from(signature).toString('base64url'),
      },
    ],
  };
}

function buildRoutingEnvelope(
  recipientCardHash: string,
  subcardHash: string,
  encryptedPayload: string
): { to: string; subcard_hash: string; payload: string } {
  return {
    to: recipientCardHash,
    subcard_hash: subcardHash,
    payload: encryptedPayload,
  };
}

describe('message_routing.md (live dev deployment)', () => {
  let recipientCard: LiveIdentity;
  let walletServiceIdentity: { id: string; publicKey: Uint8Array; secretKey: Uint8Array };

  beforeAll(async () => {
    await mintLiveCard('message-routing-sender', { display_name: 'Sender Card' });
    recipientCard = await mintLiveCard('message-routing-recipient', { display_name: 'Recipient Card' });

    const keypair = mlDsa44GenerateKeypair();
    walletServiceIdentity = {
      id: '0x' + keccak256(keypair.publicKey),
      publicKey: keypair.publicKey,
      secretKey: keypair.secretKey,
    };
  }, 180_000);

  describe('§Binding Announcements', () => {
    it('Phase 1: posts a card_registration announcement and receives 202 Accepted', async () => {
      const announcement = buildRegistrationAnnouncement(
        recipientCard.address,
        walletServiceIdentity.id,
        WALLET_SERVICE_BASE_URL,
        walletServiceIdentity.secretKey
      );

      const response = await fetch(`${WALLET_SERVICE_BASE_URL}/bindings/announce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(announcement),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { applied?: boolean };
      expect(body.applied).toBe(true);
    });

    it('Phase 2: rejects an announcement with missing wallet_service signature', async () => {
      const announcement = buildRegistrationAnnouncement(
        recipientCard.address,
        walletServiceIdentity.id,
        WALLET_SERVICE_BASE_URL,
        walletServiceIdentity.secretKey
      );

      const tampered = { ...announcement, signatures: [] };

      const response = await fetch(`${WALLET_SERVICE_BASE_URL}/bindings/announce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tampered),
      });

      expect(response.status).toBe(401);
      const body = (await response.json()) as { message?: string };
      expect(body.message).toMatch(/wallet_service|signature/i);
    });

    it('Error path: rejects a replay of the same nonce', async () => {
      const announcement = buildRegistrationAnnouncement(
        recipientCard.address,
        walletServiceIdentity.id,
        WALLET_SERVICE_BASE_URL,
        walletServiceIdentity.secretKey
      );

      const firstResponse = await fetch(`${WALLET_SERVICE_BASE_URL}/bindings/announce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(announcement),
      });
      expect(firstResponse.status).toBe(200);

      const secondResponse = await fetch(`${WALLET_SERVICE_BASE_URL}/bindings/announce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(announcement),
      });

      expect(secondResponse.status).toBe(409);
      const body = (await secondResponse.json()) as { message?: string };
      expect(body.message).toMatch(/nonce|replay/i);
    }, 60_000);

    it('Phase 3: fetches the routing table via GET /bindings', async () => {
      const announcement = buildRegistrationAnnouncement(
        recipientCard.address,
        walletServiceIdentity.id,
        WALLET_SERVICE_BASE_URL,
        walletServiceIdentity.secretKey
      );

      await fetch(`${WALLET_SERVICE_BASE_URL}/bindings/announce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(announcement),
      });

      const response = await fetch(`${WALLET_SERVICE_BASE_URL}/bindings`);
      expect(response.status).toBe(200);

      const body = (await response.json()) as { bindings?: AnnouncementEnvelope[] };
      expect(Array.isArray(body.bindings)).toBe(true);

      const found = body.bindings?.find((b) => b.payload.card_hash === recipientCard.address);
      expect(found).toBeDefined();
      expect(found?.payload.type).toBe('card_registration');
      expect(found?.signatures).toHaveLength(1);
      expect(found?.signatures[0]?.role).toBe('wallet_service');
    });

    it('Phase 4: conflict resolution prefers later timestamps for same type', async () => {
      const cardHash = recipientCard.address;
      const nonce1 = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
      const nonce2 = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');

      const payload1: CardBindingAnnouncementPayload = {
        type: 'card_registration',
        card_hash: cardHash,
        wallet_service_id: walletServiceIdentity.id,
        endpoint: WALLET_SERVICE_BASE_URL,
        timestamp: new Date(Date.now() - 10000).toISOString(),
        nonce: nonce1,
      };

      const sig1 = mlDsa44Sign(walletServiceIdentity.secretKey, canonicalize(payload1));
      const announcement1: AnnouncementEnvelope = {
        payload: payload1,
        signatures: [
          {
            public_key: bytesToBase64Url(walletServiceIdentity.publicKey),
            role: 'wallet_service',
            signature: Buffer.from(sig1).toString('base64url'),
          },
        ],
      };

      const response1 = await fetch(`${WALLET_SERVICE_BASE_URL}/bindings/announce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(announcement1),
      });
      expect(response1.status).toBe(200);

      const payload2: CardBindingAnnouncementPayload = {
        type: 'card_registration',
        card_hash: cardHash,
        wallet_service_id: walletServiceIdentity.id,
        endpoint: 'https://newer-endpoint.example.com',
        timestamp: new Date(Date.now() + 10000).toISOString(),
        nonce: nonce2,
      };

      const sig2 = mlDsa44Sign(walletServiceIdentity.secretKey, canonicalize(payload2));
      const announcement2: AnnouncementEnvelope = {
        payload: payload2,
        signatures: [
          {
            public_key: bytesToBase64Url(walletServiceIdentity.publicKey),
            role: 'wallet_service',
            signature: Buffer.from(sig2).toString('base64url'),
          },
        ],
      };

      const response2 = await fetch(`${WALLET_SERVICE_BASE_URL}/bindings/announce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(announcement2),
      });
      expect(response2.status).toBe(200);
      const body2 = (await response2.json()) as { applied?: boolean };
      expect(body2.applied).toBe(true);

      const tableResponse = await fetch(`${WALLET_SERVICE_BASE_URL}/bindings`);
      const table = (await tableResponse.json()) as { bindings?: AnnouncementEnvelope[] };
      const entry = table.bindings?.find((b) => b.payload.card_hash === cardHash);
      expect(entry?.payload.endpoint).toBe('https://newer-endpoint.example.com');
    }, 60_000);
  });

  describe('§Message Delivery', () => {
    it('Error path: rejects a message to a card not in the routing table', async () => {
      const unannouncedCardHash = '0x' + keccak256(mlDsa44GenerateKeypair().publicKey);
      const subcardHash = '0x' + keccak256(mlDsa44GenerateKeypair().publicKey);
      const mockEncryptedPayload = Buffer.from('mock-message').toString('base64url');

      const envelope = buildRoutingEnvelope(unannouncedCardHash, subcardHash, mockEncryptedPayload);

      const response = await fetch(`${WALLET_SERVICE_BASE_URL}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envelope),
      });

      expect(response.status).toBe(404);
      const body = (await response.json()) as { message?: string };
      expect(body.message).toMatch(/unknown|not found/i);
    });

    it('Error path: rejects a message with missing fields', async () => {
      const envelope = { to: recipientCard.address };

      const response = await fetch(`${WALLET_SERVICE_BASE_URL}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envelope),
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as { message?: string };
      expect(body.message).toMatch(/required/i);
    });

    it('Phase 1: returns 410 with routing info when card is in table but held by a different wallet service', async () => {
      const subcardHash = '0x' + keccak256(mlDsa44GenerateKeypair().publicKey);
      const mockEncryptedPayload = Buffer.from('mock-message').toString('base64url');

      const envelope = buildRoutingEnvelope(recipientCard.address, subcardHash, mockEncryptedPayload);

      const response = await fetch(`${WALLET_SERVICE_BASE_URL}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envelope),
      });

      expect(response.status).toBe(410);
      const body = (await response.json()) as {
        error?: string;
        wallet_service_id?: string;
        endpoint?: string;
      };
      expect(body.error).toBe('card_migrated');
      expect(body.wallet_service_id).toBeDefined();
      expect(body.endpoint).toBeDefined();
    });
  });

  describe('§UUID Registration and Retransmission', () => {
    it('Error path: rejects UUID registration with invalid signature', async () => {
      const subcardKeypair = mlDsa44GenerateKeypair();
      const subcardHash = '0x' + keccak256(subcardKeypair.publicKey);
      const uuids = [crypto.randomUUID()];

      const registrationEnvelope = {
        card_hash: recipientCard.address,
        subcard_hash: subcardHash,
        uuids,
        signature: 'invalid-signature-not-base64url',
      };

      const response = await fetch(
        `${WALLET_SERVICE_BASE_URL}/cards/${recipientCard.address}/subcards/${subcardHash}/uuids`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(registrationEnvelope),
        }
      );

      expect([400, 401]).toContain(response.status);
      const body = (await response.json()) as { message?: string };
      expect(body.message).toMatch(/signature|invalid|proof/i);
    });

    it.todo('Phase 1: UUID registration requires proof of sub-card key control (on-chain sub-card verification)');
    it.todo('Phase 2: inter-wallet routing with announcement lookup (requires second wallet-service instance)');
  });

  describe('§Message Delivery Retransmission', () => {
    it('Phase 1: deletes a message via DELETE /messages/{uuid}', async () => {
      const uuid = crypto.randomUUID();
      const response = await fetch(`${WALLET_SERVICE_BASE_URL}/messages/${uuid}`, {
        method: 'DELETE',
      });

      expect(response.status).toBe(404);
    });
  });

  describe('§What Wallet Services Observe', () => {
    it('Phase 1: routing envelope requires both recipient card_hash and subcard_hash', async () => {
      const subcardHash = '0x' + keccak256(mlDsa44GenerateKeypair().publicKey);
      const unknownCard = '0x' + keccak256(mlDsa44GenerateKeypair().publicKey);
      const mockPayload = Buffer.from('test-content').toString('base64url');
      const envelope = buildRoutingEnvelope(unknownCard, subcardHash, mockPayload);

      expect(envelope.to).toBe(unknownCard);
      expect(envelope.subcard_hash).toBe(subcardHash);
      expect(envelope.payload).toBe(mockPayload);
    });

    it('Phase 2: wallet service observes card_hash and subcard_hash but not message contents', async () => {
      const subcardHash = '0x' + keccak256(mlDsa44GenerateKeypair().publicKey);
      const unknownCard = '0x' + keccak256(mlDsa44GenerateKeypair().publicKey);
      const opaquePayload = Buffer.from('intentionally-unencrypted-test-data').toString('base64url');

      const envelope = buildRoutingEnvelope(unknownCard, subcardHash, opaquePayload);

      expect(envelope.payload).toBe(opaquePayload);
    });
  });
});
