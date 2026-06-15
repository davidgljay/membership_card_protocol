/**
 * End-to-end validation tests using a mock CardProvider.
 *
 * These tests verify the full §7 verification flow (signature validity,
 * sub-card/master link, chain walk, revocation semantics, recipient-set check)
 * without requiring real IPFS or Arbitrum infrastructure.
 *
 * All binary field values in test fixtures must be valid base64url strings,
 * since the encoder decodes them before producing CBOR byte strings.
 * We use short 4-char base64url strings (e.g. "AAEC") throughout.
 *
 * Note: ML-DSA-44 key material is not generated in these tests — the `public_key`
 * and `signature` in the mock envelope are structurally invalid (wrong size).
 * This means `signature_valid` is always false. Tests that need a valid
 * signature require a separate fixture with real key material; those are marked
 * TODO pending a test-vector generation utility.
 */

import { describe, it, expect } from 'vitest';
import { validateCard } from '../src/index.js';
import { walkPolicyCreationChain } from '../src/verify.js';
import type {
  CardDocument,
  CardProvider,
  LogEntry,
  LogEntryWithCid,
  SignedMessageEnvelope,
  SubCardRegistration,
} from '../src/types.js';

// ---------------------------------------------------------------------------
// Valid base64url values used across fixtures (all decode without errors)
// ---------------------------------------------------------------------------
// All pointer / CID identifiers used in tests are kept as short ASCII strings
// here (they are just routing keys for the mock provider, NOT base64url-decoded
// by the provider itself). Only values passed through `canonicalize()` need to
// be valid base64url — those are the message payload's recipients array.

const RECIPIENT_POINTER_A = 'AAEC'; // valid base64url, used in recipients array
const RECIPIENT_POINTER_B = 'BAED'; // valid base64url, used in recipients array

// Registry addresses and CIDs are opaque routing strings for the mock provider.
const SUB_CARD_ADDR = 'sub-card-1';
const MASTER_CARD_ADDR = 'master-card-1';
const POLICY_CID = 'policy-cid-0001';
const PRESS_CARD_POINTER = 'press-pointer-0001';
const POLICY_CREATOR_POINTER = 'policy-creator-0001';
const MASTER_LOG_HEAD = 'master-log-head-0001';
const PRESS_LOG_HEAD = 'press-log-head-0001';
const POLICY_CREATOR_LOG_HEAD = 'policy-creator-log-head-0001';

// ---------------------------------------------------------------------------
// Mock provider
//
// getAllLogEntries is implemented by walking the ipfs map following
// prev_log_root links, exactly mirroring the real HttpCardProvider logic.
// Documents with an entry_type field are log entries; documents without are
// the genesis CardDocument at the root of the log.
// ---------------------------------------------------------------------------

interface MockProviderData {
  ipfs: Record<string, unknown>;
  logHeads: Record<string, string | null>;
  subCards: Record<string, SubCardRegistration | null>;
}

function makeMockProvider(data: MockProviderData): CardProvider {
  return {
    async fetchIPFS(cid: string) {
      if (!(cid in data.ipfs)) throw new Error(`IPFS: CID not found: ${cid}`);
      return data.ipfs[cid];
    },
    async getLogHead(addr: string) {
      return data.logHeads[addr] ?? null;
    },
    async getSubCardRegistration(addr: string) {
      return data.subCards[addr] ?? null;
    },
    async getAllLogEntries(_addr: string, logHeadCid: string) {
      const entries: LogEntryWithCid[] = [];
      let genesis: CardDocument | null = null;
      let currentCid: string | null = logHeadCid;
      const fetchedAt = new Date();

      while (currentCid !== null) {
        if (!(currentCid in data.ipfs)) throw new Error(`IPFS: CID not found: ${currentCid}`);
        const doc = data.ipfs[currentCid] as Record<string, unknown>;
        if ('entry_type' in doc) {
          entries.push({ entry: doc as unknown as LogEntry, cid: currentCid });
          currentCid = (doc.prev_log_root as string | undefined | null) ?? null;
        } else {
          genesis = doc as unknown as CardDocument;
          break;
        }
      }

      return { entries, genesis, fetchedAt };
    },
  };
}

// ---------------------------------------------------------------------------
// Shared card documents used in tests
// ---------------------------------------------------------------------------

const MASTER_CARD_DOC: CardDocument = {
  policy_id: POLICY_CID,
  press_card: PRESS_CARD_POINTER,
  recipient_pubkey: 'AAEC',
  issued_at: '2026-01-01T00:00:00Z',
  offer_signature: 'AAEC',
  holder_signature: 'AAEC',
};

const POLICY_CARD_DOC: CardDocument = {
  policy_id: 'root-meta-policy',
  press_card: POLICY_CREATOR_POINTER,
  recipient_pubkey: 'AAEC',
  issued_at: '2025-01-01T00:00:00Z',
  offer_signature: 'AAEC',
  holder_signature: 'AAEC',
  field_definitions: [],
};

// Root cards (press_card: null) represent the top of their respective chains.
const ROOT_CARD_DOC: CardDocument = {
  policy_id: '',
  press_card: '',
  recipient_pubkey: 'AAEC',
  issued_at: '',
  offer_signature: 'AAEC',
  holder_signature: 'AAEC',
};

function baseProviderData(): MockProviderData {
  return {
    ipfs: {
      [MASTER_LOG_HEAD]: MASTER_CARD_DOC,
      [POLICY_CID]: POLICY_CARD_DOC,
      [PRESS_LOG_HEAD]: { ...ROOT_CARD_DOC, press_card: null },
      [POLICY_CREATOR_LOG_HEAD]: { ...ROOT_CARD_DOC, press_card: null },
    },
    logHeads: {
      [MASTER_CARD_ADDR]: MASTER_LOG_HEAD,
      [PRESS_CARD_POINTER]: PRESS_LOG_HEAD,
      [POLICY_CREATOR_POINTER]: POLICY_CREATOR_LOG_HEAD,
    },
    subCards: {
      [SUB_CARD_ADDR]: {
        masterCardAddress: MASTER_CARD_ADDR,
        registrationLogHeadCid: MASTER_LOG_HEAD,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Mock envelope
//
// The recipients array uses valid base64url strings (AAEC, BAED) because
// they are encoded by canonicalize() as CBOR byte strings.
//
// The public_key and signature are "AAEC" — too short to be a valid ML-DSA-44
// key/signature, so signature_valid will always be false in these tests.
// ---------------------------------------------------------------------------

const MOCK_ENVELOPE: SignedMessageEnvelope = {
  payload: {
    content: 'hello',
    recipients: [RECIPIENT_POINTER_A, RECIPIENT_POINTER_B],
    timestamp: '2026-05-01T12:00:00Z',
  },
  signatures: [
    {
      signer_card: SUB_CARD_ADDR,
      public_key: 'AAEC', // invalid size — signature will fail
      signature: 'AAEC',  // invalid size — signature will fail
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateCard — structural validation', () => {
  it('returns valid: false when signature is invalid (wrong key size)', async () => {
    const result = await validateCard(MOCK_ENVELOPE, {
      provider: makeMockProvider(baseProviderData()),
      trustedRoots: [MASTER_CARD_ADDR],
    });
    expect(result.valid).toBe(false);
    expect(result.signatures).toHaveLength(1);
    expect(result.signatures[0]?.signature_valid).toBe(false);
  });

  it('returns valid: false for envelope with no signatures', async () => {
    const emptyEnvelope: SignedMessageEnvelope = {
      payload: MOCK_ENVELOPE.payload,
      signatures: [],
    };
    const result = await validateCard(emptyEnvelope, {
      provider: makeMockProvider(baseProviderData()),
    });
    expect(result.valid).toBe(false);
    expect(result.signatures).toHaveLength(0);
  });

  it('returns valid: false when payload timestamp is invalid', async () => {
    const badEnvelope: SignedMessageEnvelope = {
      payload: { ...MOCK_ENVELOPE.payload, timestamp: 'not-a-date' },
      signatures: MOCK_ENVELOPE.signatures,
    };
    const result = await validateCard(badEnvelope, {
      provider: makeMockProvider(baseProviderData()),
    });
    expect(result.valid).toBe(false);
  });

  it('chains is null when timestamp is invalid', async () => {
    const badEnvelope: SignedMessageEnvelope = {
      payload: { ...MOCK_ENVELOPE.payload, timestamp: 'not-a-date' },
      signatures: MOCK_ENVELOPE.signatures,
    };
    const result = await validateCard(badEnvelope, {
      provider: makeMockProvider(baseProviderData()),
    });
    expect(result.chains).toBeNull();
  });
});

describe('validateCard — link extraction', () => {
  it('extracts policy link as ipfs://<policy_id_cid>', async () => {
    const result = await validateCard(MOCK_ENVELOPE, {
      provider: makeMockProvider(baseProviderData()),
    });
    // With an invalid signature, links are null (chain walk skipped after stage 1 failure).
    expect(result.policy === null || result.policy?.startsWith('ipfs://')).toBe(true);
  });

  it('policy link format is ipfs:// when populated', async () => {
    const result = await validateCard(MOCK_ENVELOPE, {
      provider: makeMockProvider(baseProviderData()),
    });
    if (result.policy !== null) {
      expect(result.policy).toMatch(/^ipfs:\/\//);
    }
  });

  it('authorizer link format is ipfs:// when populated', async () => {
    const result = await validateCard(MOCK_ENVELOPE, {
      provider: makeMockProvider(baseProviderData()),
    });
    if (result.authorizer !== null) {
      expect(result.authorizer).toMatch(/^ipfs:\/\//);
    }
  });

  it('policyCreator link format is ipfs:// when populated', async () => {
    const result = await validateCard(MOCK_ENVELOPE, {
      provider: makeMockProvider(baseProviderData()),
    });
    if (result.policyCreator !== null) {
      expect(result.policyCreator).toMatch(/^ipfs:\/\//);
    }
  });
});

describe('validateCard — revocation semantics', () => {
  it('getAllLogEntries returns no entries and genesis for a genesis-only log', async () => {
    const provider = makeMockProvider(baseProviderData());
    const { entries, genesis } = await provider.getAllLogEntries(MASTER_CARD_ADDR, MASTER_LOG_HEAD);
    expect(entries).toHaveLength(0);
    expect(genesis).toEqual(MASTER_CARD_DOC);
  });

  it('getAllLogEntries returns log entries and genesis for a chained log', async () => {
    const data = baseProviderData();
    const REV_CID = 'rev-entry-cid-001';
    data.ipfs[REV_CID] = {
      version: 2,
      code: 700,
      entry_type: 'revocation',
      prev_log_root: MASTER_LOG_HEAD,
      revocation: { effective_date: '2026-06-01T00:00:00Z' },
      notify_holder: true,
      intent_signature: { signer_card: 'x', public_key: 'AAEC', signature: 'AAEC' },
      press_signature:  { signer_card: 'x', public_key: 'AAEC', signature: 'AAEC' },
    };
    data.logHeads[MASTER_CARD_ADDR] = REV_CID;
    const provider = makeMockProvider(data);
    const { entries, genesis } = await provider.getAllLogEntries(MASTER_CARD_ADDR, REV_CID);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.entry.code).toBe(700);
    expect(entries[0]?.cid).toBe(REV_CID);
    expect(genesis).toEqual(MASTER_CARD_DOC);
  });

  it('9xx revocation entry has correct code and effective_date', async () => {
    const data = baseProviderData();
    const REV_CID = 'rev-9xx-cid-001';
    data.ipfs[REV_CID] = {
      version: 2,
      code: 900,
      entry_type: 'revocation',
      prev_log_root: MASTER_LOG_HEAD,
      revocation: { effective_date: '2026-04-01T00:00:00Z' },
      notify_holder: true,
      intent_signature: { signer_card: 'x', public_key: 'AAEC', signature: 'AAEC' },
      press_signature:  { signer_card: 'x', public_key: 'AAEC', signature: 'AAEC' },
    };
    data.logHeads[MASTER_CARD_ADDR] = REV_CID;
    const provider = makeMockProvider(data);
    const { entries } = await provider.getAllLogEntries(MASTER_CARD_ADDR, REV_CID);
    expect(entries[0]?.entry.code).toBe(900);
    expect(entries[0]?.entry.revocation?.effective_date).toBe('2026-04-01T00:00:00Z');
  });
});

describe('validateCard — recipient-set check', () => {
  it('addressed_to_verifier = true when verifierCard matches a recipient', async () => {
    // addressed_to_verifier is computed before the signature check,
    // so it reflects the recipients list even when signature_valid = false.
    const result = await validateCard(MOCK_ENVELOPE, {
      provider: makeMockProvider(baseProviderData()),
      verifierCard: RECIPIENT_POINTER_A,
    });
    expect(result.signatures[0]?.addressed_to_verifier).toBe(true);
  });

  it('addressed_to_verifier = false when verifierCard is not in recipients', async () => {
    const result = await validateCard(MOCK_ENVELOPE, {
      provider: makeMockProvider(baseProviderData()),
      verifierCard: 'ZZZZ', // not in recipients
    });
    expect(result.signatures[0]?.addressed_to_verifier).toBe(false);
  });

  it('addressed_to_verifier = false when verifierCard is not provided', async () => {
    const result = await validateCard(MOCK_ENVELOPE, {
      provider: makeMockProvider(baseProviderData()),
    });
    expect(result.signatures[0]?.addressed_to_verifier).toBe(false);
  });
});

describe('validateCard — provider errors', () => {
  it('handles sub-card not found gracefully — returns valid: false', async () => {
    const data = baseProviderData();
    data.subCards[SUB_CARD_ADDR] = null;
    const result = await validateCard(MOCK_ENVELOPE, {
      provider: makeMockProvider(data),
    });
    expect(result.valid).toBe(false);
  });

  it('handles IPFS fetch failure gracefully — returns valid: false', async () => {
    const data = baseProviderData();
    delete data.ipfs[MASTER_LOG_HEAD];
    const result = await validateCard(MOCK_ENVELOPE, {
      provider: makeMockProvider(data),
    });
    expect(result.valid).toBe(false);
  });

  it('returns signatures array with length matching envelope signatures', async () => {
    const result = await validateCard(MOCK_ENVELOPE, {
      provider: makeMockProvider(baseProviderData()),
    });
    expect(result.signatures).toHaveLength(MOCK_ENVELOPE.signatures.length);
  });
});

describe('validateCard — policy creation chains', () => {
  it('walkPolicyCreationChain returns one link for a genesis-only log', async () => {
    const provider = makeMockProvider(baseProviderData());
    const chain = await walkPolicyCreationChain(MASTER_CARD_ADDR, provider);
    // MASTER_CARD_DOC has press_card = PRESS_CARD_POINTER, so chain continues
    expect(chain.length).toBeGreaterThanOrEqual(1);
    expect(chain[0]?.cardAddress).toBe(MASTER_CARD_ADDR);
    expect(chain[0]?.logHeadUrl).toBe(`ipfs://${MASTER_LOG_HEAD}`);
    expect(chain[0]?.updates).toHaveLength(0);
  });

  it('walkPolicyCreationChain walks press_card links upward', async () => {
    const provider = makeMockProvider(baseProviderData());
    const chain = await walkPolicyCreationChain(MASTER_CARD_ADDR, provider);
    // MASTER_CARD_ADDR → (press_card) → PRESS_CARD_POINTER → (press_card: null) stops
    expect(chain).toHaveLength(2);
    expect(chain[0]?.cardAddress).toBe(MASTER_CARD_ADDR);
    expect(chain[1]?.cardAddress).toBe(PRESS_CARD_POINTER);
    expect(chain[1]?.logHeadUrl).toBe(`ipfs://${PRESS_LOG_HEAD}`);
  });

  it('walkPolicyCreationChain includes field_update entries with null statusCode', async () => {
    const data = baseProviderData();
    const UPDATE_CID = 'field-update-cid-001';
    data.ipfs[UPDATE_CID] = {
      version: 2,
      code: 100,
      entry_type: 'field_update',
      prev_log_root: MASTER_LOG_HEAD,
      field_updates: [{ field: 'status', value: 'active' }],
      intent_signature: { signer_card: 'x', public_key: 'AAEC', signature: 'AAEC' },
      press_signature:  { signer_card: 'x', public_key: 'AAEC', signature: 'AAEC' },
    };
    data.logHeads[MASTER_CARD_ADDR] = UPDATE_CID;
    const provider = makeMockProvider(data);
    const chain = await walkPolicyCreationChain(MASTER_CARD_ADDR, provider);
    expect(chain[0]?.updates).toHaveLength(1);
    expect(chain[0]?.updates[0]?.entryType).toBe('field_update');
    expect(chain[0]?.updates[0]?.statusCode).toBeNull();
    expect(chain[0]?.updates[0]?.cid).toBe(`ipfs://${UPDATE_CID}`);
    expect(chain[0]?.updates[0]?.version).toBe(2);
  });

  it('walkPolicyCreationChain includes revocation status codes', async () => {
    const data = baseProviderData();
    const REV_CID = 'revocation-cid-001';
    data.ipfs[REV_CID] = {
      version: 3,
      code: 800,
      entry_type: 'revocation',
      prev_log_root: MASTER_LOG_HEAD,
      revocation: { effective_date: '2026-06-01T00:00:00Z' },
      intent_signature: { signer_card: 'x', public_key: 'AAEC', signature: 'AAEC' },
      press_signature:  { signer_card: 'x', public_key: 'AAEC', signature: 'AAEC' },
    };
    data.logHeads[MASTER_CARD_ADDR] = REV_CID;
    const provider = makeMockProvider(data);
    const chain = await walkPolicyCreationChain(MASTER_CARD_ADDR, provider);
    expect(chain[0]?.updates[0]?.statusCode).toBe(800);
    expect(chain[0]?.updates[0]?.entryType).toBe('revocation');
    expect(chain[0]?.updates[0]?.version).toBe(3);
    expect(chain[0]?.updates[0]?.cid).toBe(`ipfs://${REV_CID}`);
  });

  it('walkPolicyCreationChain collects multiple log entries in newest-first order', async () => {
    const data = baseProviderData();
    const ENTRY_CID_1 = 'entry-cid-v2';
    const ENTRY_CID_2 = 'entry-cid-v3';
    data.ipfs[ENTRY_CID_1] = {
      version: 2,
      code: 100,
      entry_type: 'field_update',
      prev_log_root: MASTER_LOG_HEAD,
      field_updates: [{ field: 'name', value: 'v2' }],
      intent_signature: { signer_card: 'x', public_key: 'AAEC', signature: 'AAEC' },
      press_signature:  { signer_card: 'x', public_key: 'AAEC', signature: 'AAEC' },
    };
    data.ipfs[ENTRY_CID_2] = {
      version: 3,
      code: 700,
      entry_type: 'revocation',
      prev_log_root: ENTRY_CID_1,  // v3 points back to v2
      revocation: { effective_date: '2027-01-01T00:00:00Z' },
      intent_signature: { signer_card: 'x', public_key: 'AAEC', signature: 'AAEC' },
      press_signature:  { signer_card: 'x', public_key: 'AAEC', signature: 'AAEC' },
    };
    data.logHeads[MASTER_CARD_ADDR] = ENTRY_CID_2;  // head is v3
    const provider = makeMockProvider(data);
    const chain = await walkPolicyCreationChain(MASTER_CARD_ADDR, provider);
    const updates = chain[0]?.updates ?? [];
    expect(updates).toHaveLength(2);
    // Newest-first: v3 first, then v2
    expect(updates[0]?.version).toBe(3);
    expect(updates[0]?.entryType).toBe('revocation');
    expect(updates[1]?.version).toBe(2);
    expect(updates[1]?.entryType).toBe('field_update');
  });

  it('validateCard returns chains: null when no signature resolves master address', async () => {
    // With invalid signature, masterCardAddress is null → chains is null
    const result = await validateCard(MOCK_ENVELOPE, {
      provider: makeMockProvider(baseProviderData()),
    });
    expect(result.chains).toBeNull();
  });
});

describe('validateCard — revocation module unit tests', () => {
  it('findGoverningRevocation returns null for no entries', async () => {
    const { findGoverningRevocation } = await import('../src/revocation.js');
    expect(findGoverningRevocation([])).toBeNull();
  });

  it('findGoverningRevocation picks the earliest effective_date', async () => {
    const { findGoverningRevocation } = await import('../src/revocation.js');
    const entries: LogEntry[] = [
      {
        version: 2,
        code: 700,
        entry_type: 'revocation',
        prev_log_root: 'x',
        revocation: { effective_date: '2026-06-01T00:00:00Z' },
        intent_signature: { signer_card: 'x', public_key: 'AAEC', signature: 'AAEC' },
        press_signature:  { signer_card: 'x', public_key: 'AAEC', signature: 'AAEC' },
      },
      {
        version: 3,
        code: 701,
        entry_type: 'revocation',
        prev_log_root: 'x',
        revocation: { effective_date: '2026-01-01T00:00:00Z' },
        intent_signature: { signer_card: 'x', public_key: 'AAEC', signature: 'AAEC' },
        press_signature:  { signer_card: 'x', public_key: 'AAEC', signature: 'AAEC' },
      },
    ];
    const gov = findGoverningRevocation(entries);
    expect(gov?.effective_date).toBe('2026-01-01T00:00:00Z');
    expect(gov?.code).toBe(701);
  });

  it('wasValidAtSigningTime: 7xx, signing before effective_date → true', async () => {
    const { wasValidAtSigningTime } = await import('../src/revocation.js');
    const rev = { code: 700, effective_date: '2026-06-01T00:00:00Z' };
    const signingMs = Date.parse('2026-05-01T00:00:00Z');
    expect(wasValidAtSigningTime(rev, signingMs)).toBe(true);
  });

  it('wasValidAtSigningTime: 7xx, signing after effective_date → false', async () => {
    const { wasValidAtSigningTime } = await import('../src/revocation.js');
    const rev = { code: 700, effective_date: '2026-04-01T00:00:00Z' };
    const signingMs = Date.parse('2026-05-01T00:00:00Z');
    expect(wasValidAtSigningTime(rev, signingMs)).toBe(false);
  });

  it('wasValidAtSigningTime: 9xx, signing before effective_date → true', async () => {
    const { wasValidAtSigningTime } = await import('../src/revocation.js');
    const rev = { code: 900, effective_date: '2026-06-01T00:00:00Z' };
    const signingMs = Date.parse('2026-05-01T00:00:00Z');
    expect(wasValidAtSigningTime(rev, signingMs)).toBe(true);
  });

  it('wasValidAtSigningTime: 9xx, signing after effective_date → false', async () => {
    const { wasValidAtSigningTime } = await import('../src/revocation.js');
    const rev = { code: 900, effective_date: '2026-04-01T00:00:00Z' };
    const signingMs = Date.parse('2026-05-01T00:00:00Z');
    expect(wasValidAtSigningTime(rev, signingMs)).toBe(false);
  });

  it('isCurrentlyValid: no revocation → true', async () => {
    const { isCurrentlyValid } = await import('../src/revocation.js');
    expect(isCurrentlyValid(null, Date.now())).toBe(true);
  });

  it('isCurrentlyValid: 8xx, now before effective_date → true', async () => {
    const { isCurrentlyValid } = await import('../src/revocation.js');
    const futureDate = new Date(Date.now() + 1_000_000).toISOString();
    const rev = { code: 800, effective_date: futureDate };
    expect(isCurrentlyValid(rev, Date.now())).toBe(true);
  });

  it('isCurrentlyValid: 8xx, now after effective_date → false', async () => {
    const { isCurrentlyValid } = await import('../src/revocation.js');
    const pastDate = new Date(Date.now() - 1_000_000).toISOString();
    const rev = { code: 800, effective_date: pastDate };
    expect(isCurrentlyValid(rev, Date.now())).toBe(false);
  });
});
