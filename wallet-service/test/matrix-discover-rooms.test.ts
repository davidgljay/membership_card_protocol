import { describe, it, expect, vi } from 'vitest';
import { CardVerifier } from '@membership-card-protocol/verifier';
import type {
  ChainLink,
  EnvelopeVerificationResult,
  IpfsProvider,
  RpcProvider,
  SignedMessageEnvelope,
} from '@membership-card-protocol/verifier';
import {
  discoverEligibleRooms,
  evaluateRoomPredicate,
  InvalidDiscoveryEnvelopeError,
  type CardChainVerifier,
  type RoomPredicateDocument,
} from '../src/matrix/room-discovery.js';
import { createCardChainVerifier, CardChainVerifierNotConfiguredError } from '../src/matrix/card-chain-verifier.js';
// Reused directly from the verifier package's own test suite — same
// monorepo, same pattern client-sdk's (corrected) discovery.test.ts and
// matrix-policy-module's Python tests already use: import the package's own
// fixture-building helpers rather than re-authoring crypto fixtures.
import {
  encryptForCard,
  generateKeypair,
  makeCardDoc,
  makeSubCardDoc,
  sign,
} from '../../membership_card_verifier/packages/verifier/test/fixtures.js';

const POLICY_A = 'bafyreigh2akiscaildc-community-policy-v1';
const POLICY_B = 'bafyreiabc123-partner-org-policy-v3';
const POLICY_C = 'bafyreiznomatch-other-policy';

const IPFS_GATEWAY_URL = 'https://ipfs.example/ipfs';

function chainWithPolicy(policyId: string, fields: Record<string, unknown> = {}): ChainLink[] {
  return [{ card_address: '0xabc', public_key: 'pk', card_content: { policy_id: policyId, ...fields } }];
}

const DUMMY_ENVELOPE: SignedMessageEnvelope = {
  payload: { message: 'room-discovery-chain-walk', protocol_version: '0.1', timestamp: '2026-07-12T00:00:00Z' },
  signatures: [{ public_key: 'pk', signature: 'sig' }],
};

/** Mocks `verifyEnvelope` directly, for tests of `discoverEligibleRooms`'s
 * own orchestration/validation logic — not for proving the chain-walk
 * itself works (see the real-`CardVerifier` describe block below, which is
 * what would have caught the original verifyCard-based bug). */
function makeCardVerifier(
  chain: ChainLink[],
  overrides: Partial<EnvelopeVerificationResult['signatures'][number]> = {}
): CardChainVerifier {
  return {
    verifyEnvelope: vi.fn(async (): Promise<EnvelopeVerificationResult> => ({
      envelope_id: 'test',
      verified_at: new Date().toISOString(),
      protocol_version: '0.1',
      policy_match: null,
      signatures: [
        {
          signer_card: '0xexpected',
          scope_clean: 'skipped',
          chain_reaches_trusted_root: true,
          app_card_chain_valid: 'skipped',
          revocation: { status: 'not_revoked', code: null, effective_date: null, data_freshness_seconds: 0 },
          was_valid_at_signing_time: true,
          is_currently_valid: true,
          log_updates: [],
          press_subsequently_revoked: false,
          non_compliance_reported: false,
          addressed_to_verifier: false,
          errors: [],
          annotations: [],
          signature_valid: true,
          policy_compliant: 'skipped',
          policy_match: null,
          chain,
          ...overrides,
        },
      ],
    })),
  };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe('evaluateRoomPredicate (parity with predicates.py + client-sdk discoverRooms scenarios)', () => {
  it('matches a single entry with policy_id and satisfied field_match', () => {
    const doc: RoomPredicateDocument = {
      policies: [{ ref_type: 'cid', ref: POLICY_A, field_match: { field: 'status', regex: '^active$' } }],
    };
    expect(evaluateRoomPredicate(doc, chainWithPolicy(POLICY_A, { status: 'active' }))).toBe(true);
  });

  it('denies a single entry whose field_match fails', () => {
    const doc: RoomPredicateDocument = {
      policies: [{ ref_type: 'cid', ref: POLICY_A, field_match: { field: 'status', regex: '^active$' } }],
    };
    expect(evaluateRoomPredicate(doc, chainWithPolicy(POLICY_A, { status: 'suspended' }))).toBe(false);
  });

  it('denies a non-matching policy_id', () => {
    const doc: RoomPredicateDocument = { policies: [{ ref_type: 'cid', ref: POLICY_A }] };
    expect(evaluateRoomPredicate(doc, chainWithPolicy(POLICY_C))).toBe(false);
  });

  it('any_of across multiple entries: eligible when only one entry matches (via resolved_ref)', () => {
    const doc: RoomPredicateDocument = {
      policies: [
        { ref_type: 'cid', ref: POLICY_A, field_match: { field: 'status', regex: '^active$' } },
        { ref_type: 'pointer', ref: '0xpartner', resolved_ref: POLICY_B },
      ],
    };
    expect(evaluateRoomPredicate(doc, chainWithPolicy(POLICY_B))).toBe(true);
  });

  it('any_of across multiple entries: denied when none match', () => {
    const doc: RoomPredicateDocument = {
      policies: [
        { ref_type: 'cid', ref: POLICY_A },
        { ref_type: 'pointer', ref: '0xpartner', resolved_ref: POLICY_B },
      ],
    };
    expect(evaluateRoomPredicate(doc, chainWithPolicy(POLICY_C))).toBe(false);
  });

  it('denies an empty policies list', () => {
    expect(evaluateRoomPredicate({ policies: [] }, chainWithPolicy(POLICY_A))).toBe(false);
  });
});

describe('discoverEligibleRooms — orchestration + sender-binding (verifyEnvelope mocked)', () => {
  const roomIndex = [
    { room_id: '!room-a:matrix.internal', policy_id: 'cid-room-a' },
    { room_id: '!room-b:matrix.internal', policy_id: 'cid-room-b' },
    { room_id: '!room-c:matrix.internal', policy_id: 'cid-room-c' },
  ];

  const predicateDocs: Record<string, RoomPredicateDocument> = {
    'cid-room-a': {
      policies: [{ ref_type: 'cid', ref: POLICY_A, field_match: { field: 'status', regex: '^active$' } }],
    },
    'cid-room-b': { policies: [{ ref_type: 'cid', ref: POLICY_C }] },
    'cid-room-c': {
      policies: [
        { ref_type: 'cid', ref: POLICY_C },
        { ref_type: 'pointer', ref: '0xpartner', resolved_ref: POLICY_B },
      ],
    },
  };

  function makeFetch() {
    return vi.fn(async (url: RequestInfo | URL) => {
      const urlStr = String(url);
      for (const [cid, doc] of Object.entries(predicateDocs)) {
        if (urlStr === `${IPFS_GATEWAY_URL}/${cid}`) return jsonResponse(doc);
      }
      return jsonResponse({}, false, 404);
    });
  }

  it('returns the eligible room list for a card issued under POLICY_A (active) and POLICY_B — identical to Step 16b\'s fixture result', async () => {
    const fetchImpl = makeFetch();
    const chain: ChainLink[] = [
      { card_address: '0x1', public_key: 'pk1', card_content: { policy_id: POLICY_A, status: 'active' } },
      { card_address: '0x2', public_key: 'pk2', card_content: { policy_id: POLICY_B } },
    ];
    const cardVerifier = makeCardVerifier(chain);

    const eligible = await discoverEligibleRooms(
      DUMMY_ENVELOPE,
      '0xexpected',
      roomIndex,
      IPFS_GATEWAY_URL,
      cardVerifier,
      { fetchImpl }
    );

    expect(eligible.sort()).toEqual(['!room-a:matrix.internal', '!room-c:matrix.internal']);
  });

  it('excludes rooms whose predicate the card does not satisfy at all', async () => {
    const fetchImpl = makeFetch();
    const chain = chainWithPolicy(POLICY_C);
    const cardVerifier = makeCardVerifier(chain);

    const eligible = await discoverEligibleRooms(
      DUMMY_ENVELOPE,
      '0xexpected',
      roomIndex,
      IPFS_GATEWAY_URL,
      cardVerifier,
      { fetchImpl }
    );

    expect(eligible.sort()).toEqual(['!room-b:matrix.internal', '!room-c:matrix.internal']);
    expect(eligible).not.toContain('!room-a:matrix.internal');
  });

  it('skips (rather than fails) a room whose predicate document cannot be fetched', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url) === `${IPFS_GATEWAY_URL}/cid-room-a`) return jsonResponse(predicateDocs['cid-room-a']);
      return jsonResponse({}, false, 404);
    }) as unknown as typeof fetch;
    const chain: ChainLink[] = [
      { card_address: '0x1', public_key: 'pk1', card_content: { policy_id: POLICY_A, status: 'active' } },
    ];
    const cardVerifier = makeCardVerifier(chain);

    const eligible = await discoverEligibleRooms(
      DUMMY_ENVELOPE,
      '0xexpected',
      roomIndex,
      IPFS_GATEWAY_URL,
      cardVerifier,
      { fetchImpl }
    );

    expect(eligible).toEqual(['!room-a:matrix.internal']);
  });

  it('throws InvalidDiscoveryEnvelopeError when the envelope signature does not verify', async () => {
    const cardVerifier = makeCardVerifier(chainWithPolicy(POLICY_A), { signature_valid: false });

    await expect(
      discoverEligibleRooms(DUMMY_ENVELOPE, '0xexpected', roomIndex, IPFS_GATEWAY_URL, cardVerifier)
    ).rejects.toBeInstanceOf(InvalidDiscoveryEnvelopeError);
  });

  it('throws InvalidDiscoveryEnvelopeError when signer_card does not match the authenticated session\'s card_hash', async () => {
    const cardVerifier = makeCardVerifier(chainWithPolicy(POLICY_A), { signer_card: '0xsomeone-else' });

    await expect(
      discoverEligibleRooms(DUMMY_ENVELOPE, '0xexpected', roomIndex, IPFS_GATEWAY_URL, cardVerifier)
    ).rejects.toBeInstanceOf(InvalidDiscoveryEnvelopeError);
  });
});

describe('createCardChainVerifier (Step 16c production wiring gap)', () => {
  it('throws CardChainVerifierNotConfiguredError rather than silently returning an empty (always-denying) chain', async () => {
    const verifier = createCardChainVerifier({} as never);
    await expect(verifier.verifyEnvelope(DUMMY_ENVELOPE)).rejects.toBeInstanceOf(CardChainVerifierNotConfiguredError);
  });
});

/**
 * The test that would have caught the original bug: exercises the real
 * `CardVerifier` class end-to-end (not a mock of its methods), with a real
 * multi-hop card chain fixture — mirrors client-sdk's (corrected)
 * discovery.test.ts and matrix-policy-module's Python
 * test_chain_context.py exactly (root -> parent -> master -> sub, sub
 * signs, plus a separate app/appCertRoot certification chain, since
 * verifyEnvelope's Stage 2 requires the signer to resolve as a sub-card).
 */
describe('discoverEligibleRooms against a real CardVerifier (no mocked verifier methods)', () => {
  function buildRealChainFixture(policyId: string, status: string) {
    const root = generateKeypair();
    const parent = generateKeypair();
    const holder = generateKeypair();
    const sub = generateKeypair();
    const app = generateKeypair();
    const appCertRoot = generateKeypair();
    const press = generateKeypair();

    const parentDoc = makeCardDoc(parent.publicKey, root.secretKey, parent.secretKey, press.secretKey, [
      Buffer.from(root.publicKey).toString('base64url'),
    ]);
    (parentDoc as Record<string, unknown>)['policy_id'] = policyId;
    (parentDoc as Record<string, unknown>)['status'] = status;
    const PARENT_CID = 'QmParent';

    const holderDoc = makeCardDoc(holder.publicKey, parent.secretKey, holder.secretKey, press.secretKey, [
      Buffer.from(parent.publicKey).toString('base64url'),
    ]);
    (holderDoc as Record<string, unknown>)['policy_id'] = policyId;
    (holderDoc as Record<string, unknown>)['status'] = status;
    (holderDoc as Record<string, unknown>)['active_subcards'] = [Buffer.from(sub.publicKey).toString('base64url')];
    const MASTER_CID = 'QmMaster';

    const subDoc = makeSubCardDoc(holder.publicKey, holder.secretKey, app.publicKey, app.secretKey, sub.publicKey);
    const SUB_CID = 'QmSub';

    const appDoc = makeCardDoc(app.publicKey, appCertRoot.secretKey, app.secretKey, press.secretKey, [
      Buffer.from(appCertRoot.publicKey).toString('base64url'),
    ]);
    const APP_CID = 'QmApp';

    const encSubDoc = encryptForCard(sub.publicKey, Buffer.from(JSON.stringify(subDoc)));
    const encMasterDoc = encryptForCard(holder.publicKey, Buffer.from(JSON.stringify(holderDoc)));
    const encParentDoc = encryptForCard(parent.publicKey, Buffer.from(JSON.stringify(parentDoc)));
    const encAppDoc = encryptForCard(app.publicKey, Buffer.from(JSON.stringify(appDoc)));

    const rpc: RpcProvider = {
      async getCardEntry(address: string) {
        const entries: Record<string, { log_head_cid: string }> = {
          [sub.address]: { log_head_cid: SUB_CID },
          [holder.address]: { log_head_cid: MASTER_CID },
          [parent.address]: { log_head_cid: PARENT_CID },
          [app.address]: { log_head_cid: APP_CID },
        };
        const entry = entries[address];
        if (!entry) return null;
        return {
          log_head_cid: entry.log_head_cid,
          policy_address: '0x' + 'f'.repeat(64),
          last_press_address: press.address,
          forward_to: null,
          exists: true,
        };
      },
      async isPolicyAuthorizer(address: string) {
        return address === root.address;
      },
      async getPressAuthorization() {
        return {
          press_public_key: Buffer.from(press.publicKey).toString('hex'),
          mldsa44_key_hash: '0x',
          active: true,
          authorized_at: '2026-01-01T00:00:00Z',
          revoked_at: null,
        };
      },
      async getSubCardEntry(address: string) {
        if (address !== sub.address) return null;
        return {
          master_card_address: holder.address,
          registration_log_head: '0x',
          sub_card_doc_cid: SUB_CID,
          active: true,
          registered_at: '2026-01-01T00:00:00Z',
          deregistered_at: null,
        };
      },
      async getCardEventLog() {
        return [];
      },
      async getEasAnnotations() {
        return [];
      },
    };

    const ipfs: IpfsProvider = {
      async fetch(cid: string) {
        const docs: Record<string, Uint8Array> = {
          [SUB_CID]: encSubDoc,
          [MASTER_CID]: encMasterDoc,
          [PARENT_CID]: encParentDoc,
          [APP_CID]: encAppDoc,
        };
        const doc = docs[cid];
        if (!doc) throw new Error(`CID not found: ${cid}`);
        return doc;
      },
    };

    const payload = {
      message: 'room-discovery-chain-walk',
      protocol_version: '0.1',
      timestamp: '2026-07-12T00:00:00Z',
    };
    const envelope: SignedMessageEnvelope = {
      payload,
      signatures: [{ public_key: Buffer.from(sub.publicKey).toString('base64url'), signature: sign(sub.secretKey, payload) }],
    };

    const verifier = new CardVerifier({
      rpc,
      ipfs,
      appCertificationRoot: appCertRoot.address,
      trustedRoots: [root.address],
      returnChain: true,
    });

    return { verifier, envelope, signerCardHash: sub.address };
  }

  it('a card satisfying the room predicate is found eligible via a real end-to-end chain walk', async () => {
    const { verifier, envelope, signerCardHash } = buildRealChainFixture(POLICY_A, 'active');
    const cardVerifier: CardChainVerifier = { verifyEnvelope: (env) => verifier.verifyEnvelope(env) };

    const roomIndex = [{ room_id: '!real-room:matrix.internal', policy_id: 'cid-real-room' }];
    const predicateDoc: RoomPredicateDocument = {
      policies: [{ ref_type: 'cid', ref: POLICY_A, field_match: { field: 'status', regex: '^active$' } }],
    };
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url) === `${IPFS_GATEWAY_URL}/cid-real-room`) return jsonResponse(predicateDoc);
      return jsonResponse({}, false, 404);
    }) as unknown as typeof fetch;

    const eligible = await discoverEligibleRooms(
      envelope,
      signerCardHash,
      roomIndex,
      IPFS_GATEWAY_URL,
      cardVerifier,
      { fetchImpl }
    );

    expect(eligible).toEqual(['!real-room:matrix.internal']);
  });

  it('a card NOT satisfying the room predicate is correctly excluded via the same real chain walk', async () => {
    const { verifier, envelope, signerCardHash } = buildRealChainFixture(POLICY_A, 'suspended');
    const cardVerifier: CardChainVerifier = { verifyEnvelope: (env) => verifier.verifyEnvelope(env) };

    const roomIndex = [{ room_id: '!real-room:matrix.internal', policy_id: 'cid-real-room' }];
    const predicateDoc: RoomPredicateDocument = {
      policies: [{ ref_type: 'cid', ref: POLICY_A, field_match: { field: 'status', regex: '^active$' } }],
    };
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url) === `${IPFS_GATEWAY_URL}/cid-real-room`) return jsonResponse(predicateDoc);
      return jsonResponse({}, false, 404);
    }) as unknown as typeof fetch;

    const eligible = await discoverEligibleRooms(
      envelope,
      signerCardHash,
      roomIndex,
      IPFS_GATEWAY_URL,
      cardVerifier,
      { fetchImpl }
    );

    expect(eligible).toEqual([]);
  });

  it('rejects when the caller claims a different card_hash than the envelope actually signs for', async () => {
    const { verifier, envelope } = buildRealChainFixture(POLICY_A, 'active');
    const cardVerifier: CardChainVerifier = { verifyEnvelope: (env) => verifier.verifyEnvelope(env) };

    await expect(
      discoverEligibleRooms(envelope, '0x' + 'ff'.repeat(32), [], IPFS_GATEWAY_URL, cardVerifier)
    ).rejects.toBeInstanceOf(InvalidDiscoveryEnvelopeError);
  });
});

// No-persistent-query-log assertion (specs/process_specs/room_discovery.md §3):
// "No persistent query log. Retain only what's needed for abuse
// rate-limiting ... not a durable record of which cards queried when."
//
// discoverEligibleRooms (this file's primary export under test above) makes
// zero database calls and zero KV calls of any kind — it's a pure
// read-and-compute function over its arguments (verifyEnvelope, then a
// fetch-per-room-index-entry loop). The only place server/routes/matrix/
// discover-rooms.post.ts touches any storage at all is:
//   1. listRoomIndex(pool) — a read of the already-public room index
//      (server/db/matrix-rooms.ts), not a write.
//   2. enforceRateLimit(...) — a KV increment on kvKeys.discoverRoomsRate,
//      a short-TTL sliding-window counter (server/utils/rate-limit.ts),
//      not a durable per-query record.
// There is no insert/write call anywhere in this endpoint's code path —
// grep confirms it directly, since server/db/matrix-rooms.ts's only write
// function (insertRoomIndexEntry) is never imported by discover-rooms.post.ts
// or room-discovery.ts.
describe('no durable per-card query record (room_discovery.md §3)', () => {
  it('room-discovery.ts and the discover-rooms route never import any DB write function', async () => {
    const fs = await import('node:fs/promises');
    const routeSource = await fs.readFile(
      new URL('../server/routes/matrix/discover-rooms.post.ts', import.meta.url),
      'utf-8'
    );
    const logicSource = await fs.readFile(new URL('../src/matrix/room-discovery.ts', import.meta.url), 'utf-8');

    // The only db/matrix-rooms.js import in the route must be the read
    // function (listRoomIndex), never the write function
    // (insertRoomIndexEntry) that POST /matrix/rooms uses.
    expect(routeSource).toContain('listRoomIndex');
    expect(routeSource).not.toContain('insertRoomIndexEntry');

    // The pure logic module makes no pg/db/kv import at all.
    expect(logicSource).not.toMatch(/from ['"].*db\/matrix-rooms/);
    expect(logicSource).not.toMatch(/from ['"]pg['"]/);
    expect(logicSource).not.toContain('kv-store');
  });
});
