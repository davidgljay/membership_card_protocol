/**
 * Card issuance unit tests.
 * Tests: signCardDocument, publishCard, verifyIssuerSignature, verifyHolderSignature.
 */

import { describe, it, expect, vi } from 'vitest';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import {
  assembleCardDocument,
  signCardDocument,
  publishCard,
  verifyIssuerSignature,
  verifyHolderSignature,
} from '../../src/functions/issuance.js';

import { canonicalize, canonicalizeExcluding } from '../../src/serialization.js';
import { createDecipheriv } from 'node:crypto';
import { hkdf } from '@noble/hashes/hkdf';
import { sha3_256 } from '@noble/hashes/sha3';
import { toBase64url, fromBase64url, keccak256 } from '../../src/functions/crypto.js';
import type { PressConfig } from '../../src/config.js';
import type { IssuerOffer } from '../../src/types.js';

// Generate a deterministic press keypair.
const pressSeed = new Uint8Array(32).fill(0x11);
const { secretKey: PRESS_SK, publicKey: PRESS_PK } = ml_dsa44.keygen(pressSeed);

// Generate issuer and holder keypairs.
const issuerSeed = new Uint8Array(32).fill(0x22);
const { secretKey: ISSUER_SK, publicKey: ISSUER_PK } = ml_dsa44.keygen(issuerSeed);
const holderSeed = new Uint8Array(32).fill(0x33);
const { secretKey: HOLDER_SK, publicKey: HOLDER_PK } = ml_dsa44.keygen(holderSeed);

// `issuer_card` must equal keccak256(ancestry_pubkeys[0]) — verifyIssuerSignature's
// binding check (`protocol-objects.md §1`: ancestry_pubkeys[0] is the new card's
// immediate parent, i.e. the issuer's own public key).
const ISSUER_CARD_ADDRESS = '0x' + Buffer.from(keccak256(ISSUER_PK)).toString('hex');

const CONFIG = {
  PRESS_CARD_CID: 'bafybeipress',
  PRESS_MLDSA44_PRIVATE_KEY: PRESS_SK,
  PRESS_POLICY_CIDS: ['bafybeipolicy'],
  STALENESS_WINDOW_SECONDS: 300,
} as unknown as PressConfig;

function makeOffer(): IssuerOffer {
  const base = {
    policy_id: 'bafybeipolicy',
    issuer_card: ISSUER_CARD_ADDRESS,
    press_card: 'bafybeipress',
    issued_at: new Date().toISOString(),
    ancestry_pubkeys: [toBase64url(ISSUER_PK)],
    role: 'member',
  };
  const toSign = canonicalize(base);
  const sig = ml_dsa44.sign(toSign, ISSUER_SK);
  return {
    ...base,
    issuer_signature: toBase64url(sig),
  };
}

describe('assembleCardDocument', () => {
  it('includes protocol_version in the assembled document', () => {
    const offer = makeOffer();
    const holderSig = toBase64url(new Uint8Array(2420));
    const doc = assembleCardDocument(CONFIG, offer, toBase64url(HOLDER_PK), holderSig, [], '0.1');
    expect(doc['protocol_version']).toBe('0.1');
  });

  it('reflects the protocol_version provided by the caller', () => {
    const offer = makeOffer();
    const holderSig = toBase64url(new Uint8Array(2420));
    const doc = assembleCardDocument(CONFIG, offer, toBase64url(HOLDER_PK), holderSig, [], '0.2');
    expect(doc['protocol_version']).toBe('0.2');
  });

  it('includes all expected press fields alongside protocol_version', () => {
    const offer = makeOffer();
    const holderSig = toBase64url(new Uint8Array(2420));
    const doc = assembleCardDocument(CONFIG, offer, toBase64url(HOLDER_PK), holderSig, [], '0.1');
    expect(doc['press_card']).toBe(CONFIG.PRESS_CARD_CID);
    expect(doc['recipient_pubkey']).toBe(toBase64url(HOLDER_PK));
    expect(doc['protocol_version']).toBe('0.1');
    expect(doc['ancestry_pubkeys']).toEqual([]);
  });
});

describe('signCardDocument', () => {
  it('adds a valid press_signature to the card document', () => {
    // canonicalize imported at top of file
    const doc = { policy_id: 'p', issued_at: 'now', recipient_pubkey: toBase64url(HOLDER_PK) };
    const signed = signCardDocument(CONFIG, doc);
    expect(signed['press_signature']).toBeTruthy();
    const { press_signature: ps } = signed as { press_signature: string };
    const toVerify = canonicalizeExcluding(signed, ['press_signature']);
    expect(ml_dsa44.verify(fromBase64url(ps), toVerify, PRESS_PK)).toBe(true);
  });
});

describe('publishCard', () => {
  it('encrypts the card and uploads to IPFS', async () => {
    const mockCid = 'bafybeimock';
    let uploadedBytes: Uint8Array | null = null;
    const mockIpfs = {
      pinToIPFS: vi.fn().mockImplementation(async (bytes: Uint8Array) => {
        uploadedBytes = bytes;
        return mockCid;
      }),
    };

    const doc = {
      recipient_pubkey: toBase64url(HOLDER_PK),
      policy_id: 'bafybeipolicy',
      issued_at: new Date().toISOString(),
      press_signature: toBase64url(new Uint8Array(2420)),
    };

    const cid = await publishCard(doc, mockIpfs as import('../../src/ipfs/provider.js').IpfsPinningProvider);
    expect(cid).toBe(mockCid);

    // Verify the uploaded bytes can be decrypted back to the original doc.
    expect(uploadedBytes).not.toBeNull();
    const key = hkdf(sha3_256, HOLDER_PK, undefined, 'card-content-v1', 32);
    const nonce = uploadedBytes!.subarray(0, 12);
    const tag = uploadedBytes!.subarray(uploadedBytes!.length - 16);
    const ct = uploadedBytes!.subarray(12, uploadedBytes!.length - 16);
    const d = createDecipheriv('aes-256-gcm', key, nonce);
    d.setAuthTag(tag);
    const plain = Buffer.concat([d.update(ct), d.final()]);
    const decrypted = JSON.parse(plain.toString('utf8'));
    expect(decrypted.policy_id).toBe('bafybeipolicy');
  });
});

describe('verifyIssuerSignature', () => {
  it('returns true for a valid issuer signature', () => {
    const offer = makeOffer();
    expect(verifyIssuerSignature(offer)).toBe(true);
  });

  it('returns false when signature is tampered', () => {
    const offer = makeOffer();
    const badSig = toBase64url(new Uint8Array(2420).fill(0xff));
    const tampered = { ...offer, issuer_signature: badSig };
    expect(verifyIssuerSignature(tampered)).toBe(false);
  });

  it('returns false when ancestry_pubkeys is missing (no issuer public key to verify against)', () => {
    const offer = makeOffer();
    const { ancestry_pubkeys: _ap, ...withoutAncestry } = offer;
    expect(verifyIssuerSignature(withoutAncestry as IssuerOffer)).toBe(false);
  });

  it('returns false when ancestry_pubkeys[0] does not bind to issuer_card', () => {
    const offer = makeOffer();
    const wrongKey = ml_dsa44.keygen(new Uint8Array(32).fill(0x99)).publicKey;
    const tampered = { ...offer, ancestry_pubkeys: [toBase64url(wrongKey)] };
    expect(verifyIssuerSignature(tampered)).toBe(false);
  });
});

describe('verifyHolderSignature', () => {
  it('returns true for a valid holder signature', () => {
    const offer = makeOffer();
    const partialDoc: Record<string, unknown> = {
      ...offer,
      press_card: 'bafybeipress',
      recipient_pubkey: toBase64url(HOLDER_PK),
    };
    const toSign = canonicalizeExcluding(partialDoc, ['holder_signature', 'press_signature']);
    const sig = ml_dsa44.sign(toSign, HOLDER_SK);

    expect(verifyHolderSignature(partialDoc, toBase64url(sig))).toBe(true);
  });

  it('returns false when holder signature covers different bytes', () => {
    const holderSig = toBase64url(new Uint8Array(2420).fill(0xaa));
    expect(verifyHolderSignature({ recipient_pubkey: toBase64url(HOLDER_PK) }, holderSig)).toBe(false);
  });

  it('returns false when recipient_pubkey is missing from the document', () => {
    const holderSig = toBase64url(new Uint8Array(2420).fill(0xaa));
    expect(verifyHolderSignature({ some: 'doc' }, holderSig)).toBe(false);
  });
});
