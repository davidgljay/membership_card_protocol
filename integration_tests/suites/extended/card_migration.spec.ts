/**
 * `specs/process_specs/card_migration.md` end-to-end — Phase 5 Wave 3.
 *
 * Tests the card migration flow, covering:
 *   § Prerequisites: cardholder authentication and nonce challenge
 *   § Protocol Steps: announcement construction, dual signing, and broadcast
 *   § Peer Verification: signature validation, nonce replay detection,
 *     conflict resolution (card_migration supersedes card_registration)
 *   § Routing Table Updates: migration announcements update routing
 *
 * **Environment note:** This stack runs a single wallet-service instance, so
 * cross-wallet-service broadcast (§4) and old-wallet-service behavior (§6)
 * are not literally testable. Tests instead exercise self-routing: one wallet
 * service verifying and applying its own migration announcement, confirming
 * the local verification/nonce/conflict-resolution logic works correctly.
 * True cross-service broadcast would require a second wallet-service instance
 * and peer-list configuration, out of scope for this environment.
 *
 * Real flows tested:
 *   - Dual-signed card_migration announcement construction
 *   - Announcement verification (wallet_service + cardholder signatures)
 *   - Nonce replay detection (24-hour rolling cache)
 *   - Conflict resolution (card_migration beats card_registration)
 *   - Routing table updates after successful migration
 *   - 410 Gone with redirect hint when sending to a migrated card
 *
 * Requires the `integration_tests` stack up (`docker compose up -d --wait
 * press wallet-service redis ipfs`) and `contracts/deployments/local.json`
 * to exist.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  mlDsa44GenerateKeypair,
  mlDsa44Sign,
  mlDsa44GetPublicKey,
  keccak256,
  bytesToBase64Url,
  base64UrlToBytes,
  canonicalize,
} from '@membership-card-protocol/app-sdk';
import { mintLiveCard, type LiveIdentity, PRESS_BASE_URL } from '../support/liveCard.js';

const WALLET_SERVICE_BASE_URL = (process.env.SUITE_WALLET_SERVICE_URL ?? 'http://localhost:3002').replace(/\/$/, '');

/**
 * Payload structure for card_migration announcements (from card_migration.md).
 * Must be canonicalized before signing.
 */
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

/**
 * Construct a dual-signed card_migration announcement (from card_migration.md §3).
 * Both wallet_service and cardholder roles must sign the canonical RFC 8785 JSON.
 * The cardholder signature must use the card's master ML-DSA-44 key (no sub-cards).
 */
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

  // Wallet service signature (over the new wallet service's key)
  const wsSignature = mlDsa44Sign(newWalletServicePrivateKey, canonicalBytes);
  const wsPublicKey = mlDsa44GetPublicKey(newWalletServicePrivateKey);

  // Cardholder signature (over the cardholder's master key)
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

/**
 * Construct a card_registration announcement (for conflict resolution testing).
 */
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

/**
 * Construct a routing envelope for message delivery testing.
 */
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

describe('card_migration.md (live stack)', () => {
  let cardholderCard: LiveIdentity;
  let newWalletServiceIdentity: { id: string; publicKey: Uint8Array; secretKey: Uint8Array };

  beforeAll(async () => {
    // Mint a real card to represent the cardholder's existing card
    cardholderCard = await mintLiveCard('card-migration-cardholder', {
      display_name: 'Card Migration Suite — Cardholder',
    });

    // Generate a synthetic wallet service identity (not a real card, just keypair
    // material for signing). In a real deployment, this would be the new wallet
    // service's own registered card.
    const keypair = mlDsa44GenerateKeypair();
    newWalletServiceIdentity = {
      id: '0x' + keccak256(keypair.publicKey),
      publicKey: keypair.publicKey,
      secretKey: keypair.secretKey,
    };
  }, 60_000);

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

      // Tamper: remove the wallet_service signature, keep cardholder
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

      // Tamper: remove the cardholder signature
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

      // Tamper: corrupt the wallet_service signature
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

      // Tamper: corrupt the cardholder signature
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

      // Tamper: replace the cardholder public key with a different one
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

      // Tamper: replace the wallet_service public key
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
      // Post an announcement once
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

      // Attempt the same announcement again (same nonce)
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
      // Use a fresh card for conflict resolution testing to avoid state pollution
      // from other tests that use the same cardholderCard
      const conflictTestCard = await mintLiveCard('card-migration-conflict-test-1', {
        display_name: 'Conflict Test Card 1',
      });

      // First, post a card_registration for this card
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

      // Fetch the routing table and confirm the card_registration is there
      let tableResponse = await fetch(`${WALLET_SERVICE_BASE_URL}/bindings`);
      let table = (await tableResponse.json()) as { bindings?: AnnouncementEnvelope[] };
      let entry = table.bindings?.find((b) => b.payload.card_hash === conflictTestCard.address);
      expect(entry?.payload.type).toBe('card_registration');

      // Now post a card_migration (with later timestamp) for the same card
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

      // Fetch the routing table again and confirm the card_migration replaced it
      tableResponse = await fetch(`${WALLET_SERVICE_BASE_URL}/bindings`);
      table = (await tableResponse.json()) as { bindings?: AnnouncementEnvelope[] };
      entry = table.bindings?.find((b) => b.payload.card_hash === conflictTestCard.address);
      expect(entry?.payload.type).toBe('card_migration');
      expect(entry?.payload.endpoint).toBe(WALLET_SERVICE_BASE_URL);
    }, 60_000);

    it('Step 5: card_registration does NOT supersede card_migration for the same card_hash', async () => {
      // Use a fresh card for conflict resolution testing to avoid state pollution
      const conflictTestCard2 = await mintLiveCard('card-migration-conflict-test-2', {
        display_name: 'Conflict Test Card 2',
      });

      // First, post a card_migration
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

      // Fetch the routing table and confirm the card_migration is there
      let tableResponse = await fetch(`${WALLET_SERVICE_BASE_URL}/bindings`);
      let table = (await tableResponse.json()) as { bindings?: AnnouncementEnvelope[] };
      let entry = table.bindings?.find((b) => b.payload.card_hash === conflictTestCard2.address);
      expect(entry?.payload.type).toBe('card_migration');

      // Now try to post a card_registration (even with a later timestamp) for the same card
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
      // Should NOT be applied because card_migration takes precedence
      expect(regBody.applied).toBe(false);

      // Fetch the routing table again and confirm the card_migration is still there
      tableResponse = await fetch(`${WALLET_SERVICE_BASE_URL}/bindings`);
      table = (await tableResponse.json()) as { bindings?: AnnouncementEnvelope[] };
      entry = table.bindings?.find((b) => b.payload.card_hash === conflictTestCard2.address);
      expect(entry?.payload.type).toBe('card_migration');
      expect(entry?.payload.endpoint).toBe(WALLET_SERVICE_BASE_URL);
    }, 60_000);
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

      // Fetch the routing table
      const tableResponse = await fetch(`${WALLET_SERVICE_BASE_URL}/bindings`);
      expect(tableResponse.status).toBe(200);

      const table = (await tableResponse.json()) as { bindings?: AnnouncementEnvelope[] };
      expect(Array.isArray(table.bindings)).toBe(true);

      // Find the migrated card's entry
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
      // Post a migration announcement for this card
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

      // Now try to send a message to this card
      // The wallet service doesn't hold it (wallet_service_id in routing table
      // doesn't match its own id), so it should return 410 with redirect info
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
        '(requires second wallet-service instance with peer-list configuration — ' +
        'currently only one instance in this stack)'
    );

    it.todo(
      'Step 6: old wallet service stops accepting inbound routing envelopes for the migrated card ' +
        '(requires second wallet-service instance to verify behavior)'
    );

    it.todo(
      'Step 6: old wallet service forwards queued, undelivered messages to the new wallet service ' +
        '(requires second wallet-service instance and message queue state)'
    );

    it.todo(
      'Step 6: old wallet service removes card from its local store after processing migration ' +
        '(requires second wallet-service instance to verify deletion)'
    );
  });
});
