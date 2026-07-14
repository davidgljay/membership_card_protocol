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
  discoverRooms,
  evaluateRoomPredicate,
  type CardChainVerifier,
  type RoomIndexResponse,
  type RoomPredicateDocument,
} from '../../src/matrix/discovery.js';
import { mlDsa44GenerateKeypair } from '../../src/crypto/mldsa.js';
// Reused directly from the verifier package's own test suite, same monorepo,
// same pattern wallet-service/matrix-policy-module's Python tests already
// use (import the package's own fixture-building helpers rather than
// re-authoring crypto fixtures) — see that package's test/fixtures.ts.
import {
  encryptForCard,
  generateKeypair,
  makeCardDoc,
  makeSubCardDoc,
  sign,
} from '../../../../../membership_card_verifier/packages/verifier/test/fixtures.js';

const CARD_SECRET_KEY = mlDsa44GenerateKeypair().secretKey;

const POLICY_A = 'bafyreigh2akiscaildc-community-policy-v1';
const POLICY_B = 'bafyreiabc123-partner-org-policy-v3';
const POLICY_C = 'bafyreiznomatch-other-policy';

function chainWithPolicy(policyId: string, fields: Record<string, unknown> = {}): ChainLink[] {
  return [
    {
      card_address: '0xabc',
      public_key: 'pk',
      card_content: { policy_id: policyId, ...fields },
    },
  ];
}

/**
 * Mocks `verifyEnvelope` directly, for tests that only care about
 * `discoverRooms`'s own orchestration logic (fetching the index, evaluating
 * predicates) — not for proving the chain-walk itself works. See the
 * `real CardVerifier` describe block below for that; mocking at this
 * boundary is exactly how the original verifyCard-based bug went
 * undetected, so it must not be the only kind of test in this file.
 */
function makeCardVerifier(chain: ChainLink[]): CardChainVerifier {
  return {
    verifyEnvelope: vi.fn(async (): Promise<EnvelopeVerificationResult> => ({
      envelope_id: 'test',
      verified_at: new Date().toISOString(),
      protocol_version: '0.1',
      signatures: [
        {
          signer_card: '0xsigner',
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
          chain,
        },
      ],
    })),
  };
}

/** Records every call made to it — used to assert no request is identity-bound. */
function makeRecordingFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

const ROOM_INDEX_URL = 'https://wallet-service.example/matrix/room-index';
const IPFS_GATEWAY_URL = 'https://ipfs.example/ipfs';

describe('evaluateRoomPredicate (mirrors predicates.py test_predicates.py scenarios)', () => {
  it('matches a single entry with policy_id and satisfied field_match', () => {
    const doc: RoomPredicateDocument = {
      policies: [{ ref_type: 'cid', ref: POLICY_A, field_match: { field: 'status', regex: '^active$' } }],
    };
    const chain = chainWithPolicy(POLICY_A, { status: 'active' });
    expect(evaluateRoomPredicate(doc, chain)).toBe(true);
  });

  it('denies a single entry whose field_match fails', () => {
    const doc: RoomPredicateDocument = {
      policies: [{ ref_type: 'cid', ref: POLICY_A, field_match: { field: 'status', regex: '^active$' } }],
    };
    const chain = chainWithPolicy(POLICY_A, { status: 'suspended' });
    expect(evaluateRoomPredicate(doc, chain)).toBe(false);
  });

  it('denies a non-matching policy_id', () => {
    const doc: RoomPredicateDocument = { policies: [{ ref_type: 'cid', ref: POLICY_A }] };
    const chain = chainWithPolicy(POLICY_C);
    expect(evaluateRoomPredicate(doc, chain)).toBe(false);
  });

  it('any_of across multiple entries: eligible when only one entry matches', () => {
    const doc: RoomPredicateDocument = {
      policies: [
        { ref_type: 'cid', ref: POLICY_A, field_match: { field: 'status', regex: '^active$' } },
        { ref_type: 'pointer', ref: '0xpartner', resolved_ref: POLICY_B },
      ],
    };
    // Fails entry 1 (wrong policy_id), satisfies entry 2 (resolved_ref, no field_match).
    const chain = chainWithPolicy(POLICY_B);
    expect(evaluateRoomPredicate(doc, chain)).toBe(true);
  });

  it('any_of across multiple entries: denied when none match', () => {
    const doc: RoomPredicateDocument = {
      policies: [
        { ref_type: 'cid', ref: POLICY_A },
        { ref_type: 'pointer', ref: '0xpartner', resolved_ref: POLICY_B },
      ],
    };
    const chain = chainWithPolicy(POLICY_C);
    expect(evaluateRoomPredicate(doc, chain)).toBe(false);
  });

  it('uses resolved_ref, not the raw pointer address, for pointer-originated entries', () => {
    const doc: RoomPredicateDocument = {
      policies: [{ ref_type: 'pointer', ref: '0x9f2c-partner-org-policy-address', resolved_ref: POLICY_B }],
    };
    const chain = chainWithPolicy(POLICY_B);
    expect(evaluateRoomPredicate(doc, chain)).toBe(true);
  });

  it('denies an empty policies list', () => {
    expect(evaluateRoomPredicate({ policies: [] }, chainWithPolicy(POLICY_A))).toBe(false);
  });
});

describe('discoverRooms (orchestration logic, verifyEnvelope mocked)', () => {
  const roomIndex: RoomIndexResponse = {
    rooms: [
      { room_id: '!room-a:matrix.internal', policy_id: 'cid-room-a', created_at: '2026-07-10T18:00:00Z' },
      { room_id: '!room-b:matrix.internal', policy_id: 'cid-room-b', created_at: '2026-07-10T18:05:00Z' },
      { room_id: '!room-c:matrix.internal', policy_id: 'cid-room-c', created_at: '2026-07-10T18:10:00Z' },
    ],
    updated_at: '2026-07-11T09:00:00Z',
  };

  const predicateDocs: Record<string, RoomPredicateDocument> = {
    // room-a: single entry, matching policy + field.
    'cid-room-a': {
      policies: [{ ref_type: 'cid', ref: POLICY_A, field_match: { field: 'status', regex: '^active$' } }],
    },
    // room-b: single entry, non-matching policy.
    'cid-room-b': { policies: [{ ref_type: 'cid', ref: POLICY_C }] },
    // room-c: multi-entry any_of, only the second entry (a pointer/resolved_ref) matches.
    'cid-room-c': {
      policies: [
        { ref_type: 'cid', ref: POLICY_C },
        { ref_type: 'pointer', ref: '0xpartner', resolved_ref: POLICY_B },
      ],
    },
  };

  function makeFetch() {
    return makeRecordingFetch((url) => {
      if (url === ROOM_INDEX_URL) return jsonResponse(roomIndex);
      for (const [cid, doc] of Object.entries(predicateDocs)) {
        if (url === `${IPFS_GATEWAY_URL}/${cid}`) return jsonResponse(doc);
      }
      return jsonResponse({}, false, 404);
    });
  }

  it('returns the eligible room list for a card issued under POLICY_A (active) and POLICY_B', async () => {
    const { fetchImpl } = makeFetch();
    const chain: ChainLink[] = [
      { card_address: '0x1', public_key: 'pk1', card_content: { policy_id: POLICY_A, status: 'active' } },
      { card_address: '0x2', public_key: 'pk2', card_content: { policy_id: POLICY_B } },
    ];
    const cardVerifier = makeCardVerifier(chain);

    const eligible = await discoverRooms(CARD_SECRET_KEY, ROOM_INDEX_URL, IPFS_GATEWAY_URL, cardVerifier, { fetchImpl });

    expect(eligible.sort()).toEqual(['!room-a:matrix.internal', '!room-c:matrix.internal']);
  });

  it('excludes rooms whose predicate the card does not satisfy at all', async () => {
    const { fetchImpl } = makeFetch();
    const chain = chainWithPolicy(POLICY_C);
    const cardVerifier = makeCardVerifier(chain);

    const eligible = await discoverRooms(CARD_SECRET_KEY, ROOM_INDEX_URL, IPFS_GATEWAY_URL, cardVerifier, { fetchImpl });

    expect(eligible.sort()).toEqual(['!room-b:matrix.internal', '!room-c:matrix.internal']);
    expect(eligible).not.toContain('!room-a:matrix.internal');
  });

  it('never sends card-identifying data in any outgoing network call', async () => {
    const { fetchImpl, calls } = makeFetch();
    const chain: ChainLink[] = [
      { card_address: '0x1', public_key: 'pk1', card_content: { policy_id: POLICY_A, status: 'active' } },
    ];
    const cardVerifier = makeCardVerifier(chain);

    await discoverRooms(CARD_SECRET_KEY, ROOM_INDEX_URL, IPFS_GATEWAY_URL, cardVerifier, { fetchImpl });

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const init = call.init ?? {};
      const serializedInit = JSON.stringify(init);
      expect(serializedInit.toLowerCase()).not.toContain('authorization');
      expect(serializedInit.toLowerCase()).not.toContain('cookie');
      expect(init.method ?? 'GET').toBe('GET');
      expect((init as { credentials?: string }).credentials).toBeUndefined();
    }

    // Confirm we actually exercised both network surfaces (room index + IPFS gateway),
    // not just an empty call list that trivially passes the assertions above.
    expect(calls.some((c) => c.url === ROOM_INDEX_URL)).toBe(true);
    expect(calls.some((c) => c.url.startsWith(IPFS_GATEWAY_URL))).toBe(true);
  });

  it('skips (rather than fails) a room whose predicate document cannot be fetched', async () => {
    const { fetchImpl } = makeRecordingFetch((url) => {
      if (url === ROOM_INDEX_URL) return jsonResponse(roomIndex);
      if (url === `${IPFS_GATEWAY_URL}/cid-room-a`) return jsonResponse(predicateDocs['cid-room-a']);
      return jsonResponse({}, false, 404); // room-b and room-c's predicate docs are "unreachable"
    });
    const chain: ChainLink[] = [
      { card_address: '0x1', public_key: 'pk1', card_content: { policy_id: POLICY_A, status: 'active' } },
    ];
    const cardVerifier = makeCardVerifier(chain);

    const eligible = await discoverRooms(CARD_SECRET_KEY, ROOM_INDEX_URL, IPFS_GATEWAY_URL, cardVerifier, { fetchImpl });

    expect(eligible).toEqual(['!room-a:matrix.internal']);
  });

  it('throws if the room index itself cannot be fetched', async () => {
    const { fetchImpl } = makeRecordingFetch(() => jsonResponse({}, false, 500));
    const cardVerifier = makeCardVerifier([]);

    await expect(
      discoverRooms(CARD_SECRET_KEY, ROOM_INDEX_URL, IPFS_GATEWAY_URL, cardVerifier, { fetchImpl })
    ).rejects.toThrow();
  });
});

/**
 * The test that would have caught the original bug: exercises the real
 * `CardVerifier` class (not a mock of its methods) end-to-end, with a real
 * signed envelope and a real multi-hop card chain fixture — the same
 * fixture shape (root -> parent -> master -> sub, sub signs) used by the
 * verifier package's own tests and by wallet-service/matrix-policy-module's
 * Python equivalent (test_chain_context.py), since verifyEnvelope's Stage 2
 * requires the signer to resolve as a sub-card, not a bare master card.
 */
describe('discoverRooms against a real CardVerifier (no mocked verifier methods)', () => {
  function buildRealChainFixture(policyId: string, status: string) {
    // root (trusted) <- parent <- holder (master) <- sub (signs the statement),
    // plus a separate app <- appCertRoot chain (Stage 2 also walks the
    // signer's app-card certification chain, distinct from the card-holder
    // ancestry chain) — mirrors matrix-policy-module's Python
    // test_chain_context.py fixture exactly; missing the app/appCertRoot
    // pair here was the cause of this test's first failed attempt
    // (`stage2.ts` reading `ancestry_pubkeys` off an app card doc that was
    // never actually resolvable).
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
      async getLogEntries() {
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

    return { verifier, envelope, subSecretKey: sub.secretKey };
  }

  it('a card satisfying the room predicate is found eligible via a real end-to-end chain walk', async () => {
    const { verifier, envelope, subSecretKey } = buildRealChainFixture(POLICY_A, 'active');

    // Sanity check the fixture itself actually produces a real, non-empty chain —
    // this is exactly the assertion the original bug would have failed.
    const rawResult = await verifier.verifyEnvelope(envelope);
    expect(rawResult.signatures[0]?.chain?.length ?? 0).toBeGreaterThan(0);

    const cardVerifier: CardChainVerifier = {
      verifyEnvelope: (env) => verifier.verifyEnvelope(env),
    };

    const roomIndex: RoomIndexResponse = {
      rooms: [{ room_id: '!real-room:matrix.internal', policy_id: 'cid-real-room', created_at: '2026-07-12T00:00:00Z' }],
      updated_at: '2026-07-12T00:00:00Z',
    };
    const predicateDoc: RoomPredicateDocument = {
      policies: [{ ref_type: 'cid', ref: POLICY_A, field_match: { field: 'status', regex: '^active$' } }],
    };
    const { fetchImpl } = makeRecordingFetch((url) => {
      if (url === ROOM_INDEX_URL) return jsonResponse(roomIndex);
      if (url === `${IPFS_GATEWAY_URL}/cid-real-room`) return jsonResponse(predicateDoc);
      return jsonResponse({}, false, 404);
    });

    const eligible = await discoverRooms(subSecretKey, ROOM_INDEX_URL, IPFS_GATEWAY_URL, cardVerifier, { fetchImpl });

    expect(eligible).toEqual(['!real-room:matrix.internal']);
  });

  it('a card NOT satisfying the room predicate is correctly excluded via the same real chain walk', async () => {
    const { verifier, envelope, subSecretKey } = buildRealChainFixture(POLICY_A, 'suspended');
    const cardVerifier: CardChainVerifier = {
      verifyEnvelope: (env) => verifier.verifyEnvelope(env),
    };
    void envelope;

    const roomIndex: RoomIndexResponse = {
      rooms: [{ room_id: '!real-room:matrix.internal', policy_id: 'cid-real-room', created_at: '2026-07-12T00:00:00Z' }],
      updated_at: '2026-07-12T00:00:00Z',
    };
    const predicateDoc: RoomPredicateDocument = {
      policies: [{ ref_type: 'cid', ref: POLICY_A, field_match: { field: 'status', regex: '^active$' } }],
    };
    const { fetchImpl } = makeRecordingFetch((url) => {
      if (url === ROOM_INDEX_URL) return jsonResponse(roomIndex);
      if (url === `${IPFS_GATEWAY_URL}/cid-real-room`) return jsonResponse(predicateDoc);
      return jsonResponse({}, false, 404);
    });

    const eligible = await discoverRooms(subSecretKey, ROOM_INDEX_URL, IPFS_GATEWAY_URL, cardVerifier, { fetchImpl });

    expect(eligible).toEqual([]);
  });
});
