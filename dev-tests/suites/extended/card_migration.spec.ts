/**
 * `specs/process_specs/card_migration.md` end-to-end, against the live dev
 * deployment. Ported from
 * integration_tests/suites/extended/card_migration.spec.ts unchanged in
 * test logic -- only the wallet-service base URL source changed (from
 * `process.env.SUITE_WALLET_SERVICE_URL` to `../../support/liveCard.js`'s
 * `WALLET_SERVICE_BASE_URL`, backed by `DEV_WALLET_SERVICE_URL`).
 *
 * Tests the card migration flow, covering:
 *   § Prerequisites: cardholder authentication and nonce challenge
 *   § Protocol Steps: announcement construction, dual signing, and broadcast
 *   § Peer Verification: signature validation, nonce replay detection,
 *     conflict resolution (card_migration supersedes card_registration)
 *   § Routing Table Updates: migration announcements update routing
 *
 * **Environment note, unchanged from the original**: this deployment runs a
 * single wallet-service instance, so cross-wallet-service broadcast (§4)
 * and old-wallet-service behavior (§6) are not literally testable. Tests
 * instead exercise self-routing: one wallet service verifying and applying
 * its own migration announcement.
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

function buildMigrationAnnouncement(
  cardholderCard: LiveIdentity,
  newWalletServiceId: string,
  newWalletServiceEndpoint: string,
  newWalletServicePrivateKey: Uint8Array
): AnnouncementEnvelope {
  const payload: CardBindingAnnouncementPayload = {
    type: 'card_migration',
    card_hash: cardholderCard.address,
    wallet_service_id: newWalletServiceId,
    endpoint: newWalletServiceEndpoint,
    timestamp: new Date().toISOString(),
    nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
  };

  const canonicalBytes = canonicalize(payload);

  const wsSignature = mlDsa44Sign(newWalletServicePrivateKey, canonicalBytes);
  const wsPublicKey = mlDsa44GetPublicKey(newWalletServicePrivateKey);

  const chSignature = mlDsa44Sign(cardholderCard.secretKey, canonicalBytes);

  return {
    payload,
    signatures: [
      {
        public_key: bytesToBase64Url(wsPublicKey),
        role: 'wallet_service',
        signature: Buffer.from(wsSignature).toString('base64url'),
      },
      {
        public_key: bytesToBase64Url(cardholderCard.publicKey),
        role: 'cardholder',
        signature: Buffer.from(chSignature).toString('base64url'),
      },
    ],
  };
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

describe('card_migration.md (live dev deployment)', () => {
  let cardholderCard: LiveIdentity;
  let newWalletServiceIdentity: { id: string; publicKey: Uint8Array; secretKey: Uint8Array };

  beforeAll(async () => {
    cardholderCard = await mintLiveCard('card-migration-cardholder', {
      display_name: 'Card Migration Suite — Cardholder',
    });

    const keypair = mlDsa44GenerateKeypair();
    newWalletServiceIdentity = {
      id: '0x' + keccak256(keypair.publicKey),
      publicKey: keypair.publicKey,
      secretKey: keypair.secretKey,
    };
  }, 120_000);

  describe('§Announcement Construction and Verification', () => {
    it('Step 1-3: posts a dual-signed card_migration announcement and receives 200 OK', async () => {
      const announcement = buildMigrationAnnouncement(
        cardholderCard,
        newWalletServiceIdentity.id,
        WALLET_SERVICE_BASE_URL,
        newWalletServiceIdentity.secretKey
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

    it('Error path: rejects a card_migration with missing wallet_service signature', async () => {
      const announcement = buildMigrationAnnouncement(
        cardholderCard,
        newWalletServiceIdentity.id,
        WALLET_SERVICE_BASE_URL,
        newWalletServiceIdentity.secretKey
      );

      const tampered = {
        ...announcement,
        signatures: announcement.signatures.filter((s) => s.role === 'cardholder'),
      };

      const response = await fetch(`${WALLET_SERVICE_BASE_URL}/bindings/announce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tampered),
      });

      expect(response.status).toBe(401);
      const body = (await response.json()) as { message?: string };
      expect(body.message).toMatch(/wallet_service|signature/i);
    });

    it('Error path: rejects a card_migration with missing cardholder signature', async () => {
      const announcement = buildMigrationAnnouncement(
        cardholderCard,
        newWalletServiceIdentity.id,
        WALLET_SERVICE_BASE_URL,
        newWalletServiceIdentity.secretKey
      );

      const tampered = {
        ...announcement,
        signatures: announcement.signatures.filter((s) => s.role === 'wallet_service'),
      };

      const response = await fetch(`${WALLET_SERVICE_BASE_URL}/bindings/announce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tampered),
      });

      expect(response.status).toBe(401);
      const body = (await response.json()) as { message?: string };
      expect(body.message).toMatch(/cardholder|signature|card_migration/i);
    });

    it('Error path: rejects a card_migration with invalid wallet_service signature', async () => {
      const announcement = buildMigrationAnnouncement(
        cardholderCard,
        newWalletServiceIdentity.id,
        WALLET_SERVICE_BASE_URL,
        newWalletServiceIdentity.secretKey
      );

      const tampered = {
        ...announcement,
        signatures: announcement.signatures.map((s) =>
          s.role === 'wallet_service' ? { ...s, signature: 'aW52YWxpZFNpZ25hdHVyZQ==' } : s
        ),
      };

      const response = await fetch(`${WALLET_SERVICE_BASE_URL}/bindings/announce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tampered),
      });

      expect(response.status).toBe(401);
      const body = (await response.json()) as { message?: string };
      expect(body.message).toMatch(/wallet_service|signature/i);
    });

    it('Error path: rejects a card_migration with invalid cardholder signature', async () => {
      const announcement = buildMigrationAnnouncement(
        cardholderCard,
        newWalletServiceIdentity.id,
        WALLET_SERVICE_BASE_URL,
        newWalletServiceIdentity.secretKey
      );

      const tampered = {
        ...announcement,
        signatures: announcement.signatures.map((s) =>
          s.role === 'cardholder' ? { ...s, signature: 'aW52YWxpZFNpZ25hdHVyZQ==' } : s
        ),
      };

      const response = await fetch(`${WALLET_SERVICE_BASE_URL}/bindings/announce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tampered),
      });

      expect(response.status).toBe(401);
      const body = (await response.json()) as { message?: string };
      expect(body.message).toMatch(/cardholder|signature/i);
    });

    it('Error path: rejects a card_migration where cardholder public key does not match card_hash', async () => {
      const announcement = buildMigrationAnnouncement(
        cardholderCard,
        newWalletServiceIdentity.id,
        WALLET_SERVICE_BASE_URL,
        newWalletServiceIdentity.secretKey
      );

      const wrongKeypair = mlDsa44GenerateKeypair();
      const tampered = {
        ...announcement,
        signatures: announcement.signatures.map((s) =>
          s.role === 'cardholder' ? { ...s, public_key: bytesToBase64Url(wrongKeypair.publicKey) } : s
        ),
      };

      const response = await fetch(`${WALLET_SERVICE_BASE_URL}/bindings/announce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tampered),
      });

      expect(response.status).toBe(401);
      const body = (await response.json()) as { message?: string };
      expect(body.message).toMatch(/cardholder|public key|card_hash/i);
    });

    it('Error path: rejects a card_migration where wallet_service public key does not match wallet_service_id', async () => {
      const announcement = buildMigrationAnnouncement(
        cardholderCard,
        newWalletServiceIdentity.id,
        WALLET_SERVICE_BASE_URL,
        newWalletServiceIdentity.secretKey
      );

      const wrongKeypair = mlDsa44GenerateKeypair();
      const tampered = {
        ...announcement,
        signatures: announcement.signatures.map((s) =>
          s.role === 'wallet_service' ? { ...s, public_key: bytesToBase64Url(wrongKeypair.publicKey) } : s
        ),
      };

      const response = await fetch(`${WALLET_SERVICE_BASE_URL}/bindings/announce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tampered),
      });

      expect(response.status).toBe(401);
      const body = (await response.json()) as { message?: string };
      expect(body.message).toMatch(/wallet_service|public key|wallet_service_id/i);
    });
  });

  describe('§Nonce Replay Detection', () => {
    it('Error path: rejects a replay of the same nonce', async () => {
      const announcement = buildMigrationAnnouncement(
        cardholderCard,
        newWalletServiceIdentity.id,
        WALLET_SERVICE_BASE_URL,
        newWalletServiceIdentity.secretKey
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
    });
  });

  describe('§Conflict Resolution', () => {
    it('Step 5: card_migration supersedes card_registration for the same card_hash', async () => {
      const conflictTestCard = await mintLiveCard('card-migration-conflict-test-1', {
        display_name: 'Conflict Test Card 1',
      });

      const oldWalletKeypair = mlDsa44GenerateKeypair();
      const registrationAnnouncement = buildRegistrationAnnouncement(
        conflictTestCard.address,
        '0x' + keccak256(oldWalletKeypair.publicKey),
        'https://old-wallet.example.com',
        oldWalletKeypair.secretKey
      );

      const regResponse = await fetch(`${WALLET_SERVICE_BASE_URL}/bindings/announce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(registrationAnnouncement),
      });
      expect(regResponse.status).toBe(200);
      const regBody = (await regResponse.json()) as { applied?: boolean };
      expect(regBody.applied).toBe(true);

      let tableResponse = await fetch(`${WALLET_SERVICE_BASE_URL}/bindings`);
      let table = (await tableResponse.json()) as { bindings?: AnnouncementEnvelope[] };
      let entry = table.bindings?.find((b) => b.payload.card_hash === conflictTestCard.address);
      expect(entry?.payload.type).toBe('card_registration');

      const migrationAnnouncement = buildMigrationAnnouncement(
        conflictTestCard,
        newWalletServiceIdentity.id,
        WALLET_SERVICE_BASE_URL,
        newWalletServiceIdentity.secretKey
      );

      const migResponse = await fetch(`${WALLET_SERVICE_BASE_URL}/bindings/announce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(migrationAnnouncement),
      });
      expect(migResponse.status).toBe(200);
      const migBody = (await migResponse.json()) as { applied?: boolean };
      expect(migBody.applied).toBe(true);

      tableResponse = await fetch(`${WALLET_SERVICE_BASE_URL}/bindings`);
      table = (await tableResponse.json()) as { bindings?: AnnouncementEnvelope[] };
      entry = table.bindings?.find((b) => b.payload.card_hash === conflictTestCard.address);
      expect(entry?.payload.type).toBe('card_migration');
      expect(entry?.payload.endpoint).toBe(WALLET_SERVICE_BASE_URL);
    }, 120_000);

    it('Step 5: card_registration does NOT supersede card_migration for the same card_hash', async () => {
      const conflictTestCard2 = await mintLiveCard('card-migration-conflict-test-2', {
        display_name: 'Conflict Test Card 2',
      });

      const migrationAnnouncement = buildMigrationAnnouncement(
        conflictTestCard2,
        newWalletServiceIdentity.id,
        WALLET_SERVICE_BASE_URL,
        newWalletServiceIdentity.secretKey
      );

      const migResponse = await fetch(`${WALLET_SERVICE_BASE_URL}/bindings/announce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(migrationAnnouncement),
      });
      expect(migResponse.status).toBe(200);
      const migBody = (await migResponse.json()) as { applied?: boolean };
      expect(migBody.applied).toBe(true);

      let tableResponse = await fetch(`${WALLET_SERVICE_BASE_URL}/bindings`);
      let table = (await tableResponse.json()) as { bindings?: AnnouncementEnvelope[] };
      let entry = table.bindings?.find((b) => b.payload.card_hash === conflictTestCard2.address);
      expect(entry?.payload.type).toBe('card_migration');

      const newWalletKeypair = mlDsa44GenerateKeypair();
      const registrationAnnouncement = buildRegistrationAnnouncement(
        conflictTestCard2.address,
        '0x' + keccak256(newWalletKeypair.publicKey),
        'https://new-wallet.example.com',
        newWalletKeypair.secretKey
      );

      const regResponse = await fetch(`${WALLET_SERVICE_BASE_URL}/bindings/announce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(registrationAnnouncement),
      });
      expect(regResponse.status).toBe(200);
      const regBody = (await regResponse.json()) as { applied?: boolean };
      expect(regBody.applied).toBe(false);

      tableResponse = await fetch(`${WALLET_SERVICE_BASE_URL}/bindings`);
      table = (await tableResponse.json()) as { bindings?: AnnouncementEnvelope[] };
      entry = table.bindings?.find((b) => b.payload.card_hash === conflictTestCard2.address);
      expect(entry?.payload.type).toBe('card_migration');
      expect(entry?.payload.endpoint).toBe(WALLET_SERVICE_BASE_URL);
    }, 120_000);
  });

  describe('§Routing Table Updates', () => {
    it('Step 5: updates routing table to reflect new wallet_service_id', async () => {
      const announcement = buildMigrationAnnouncement(
        cardholderCard,
        newWalletServiceIdentity.id,
        WALLET_SERVICE_BASE_URL,
        newWalletServiceIdentity.secretKey
      );

      const response = await fetch(`${WALLET_SERVICE_BASE_URL}/bindings/announce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(announcement),
      });

      expect(response.status).toBe(200);

      const tableResponse = await fetch(`${WALLET_SERVICE_BASE_URL}/bindings`);
      expect(tableResponse.status).toBe(200);

      const table = (await tableResponse.json()) as { bindings?: AnnouncementEnvelope[] };
      expect(Array.isArray(table.bindings)).toBe(true);

      const entry = table.bindings?.find((b) => b.payload.card_hash === cardholderCard.address);
      expect(entry).toBeDefined();
      expect(entry?.payload.type).toBe('card_migration');
      expect(entry?.payload.wallet_service_id).toBe(newWalletServiceIdentity.id);
      expect(entry?.payload.endpoint).toBe(WALLET_SERVICE_BASE_URL);
      expect(entry?.signatures).toHaveLength(2);
      expect(entry?.signatures?.find((s) => s.role === 'wallet_service')).toBeDefined();
      expect(entry?.signatures?.find((s) => s.role === 'cardholder')).toBeDefined();
    });
  });

  describe('§Message Delivery After Migration', () => {
    it('Step 6 (self-routing): returns 410 when sending to a migrated card held by a different wallet service', async () => {
      const migrationAnnouncement = buildMigrationAnnouncement(
        cardholderCard,
        newWalletServiceIdentity.id,
        'https://new-wallet-endpoint.example.com',
        newWalletServiceIdentity.secretKey
      );

      const migResponse = await fetch(`${WALLET_SERVICE_BASE_URL}/bindings/announce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(migrationAnnouncement),
      });
      expect(migResponse.status).toBe(200);

      const subcardHash = '0x' + keccak256(mlDsa44GenerateKeypair().publicKey);
      const mockEncryptedPayload = Buffer.from('mock-message').toString('base64url');

      const envelope = buildRoutingEnvelope(cardholderCard.address, subcardHash, mockEncryptedPayload);

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
      expect(body.wallet_service_id).toBe(newWalletServiceIdentity.id);
      expect(body.endpoint).toBe('https://new-wallet-endpoint.example.com');
    });
  });

  describe('§Cross-Wallet Scenarios', () => {
    it.todo(
      'Step 4: broadcasts card_migration announcement to all peer wallet services ' +
        '(requires a second wallet-service instance with peer-list configuration)'
    );

    it.todo(
      'Step 6: old wallet service stops accepting inbound routing envelopes for the migrated card ' +
        '(requires a second wallet-service instance to verify behavior)'
    );

    it.todo(
      'Step 6: old wallet service forwards queued, undelivered messages to the new wallet service ' +
        '(requires a second wallet-service instance and message queue state)'
    );

    it.todo(
      'Step 6: old wallet service removes card from its local store after processing migration ' +
        '(requires a second wallet-service instance to verify deletion)'
    );
  });
});
