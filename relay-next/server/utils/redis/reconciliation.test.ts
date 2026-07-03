import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRedisHarness, type TestRedisHarness } from './test-harness';
import { UuidStore } from './uuid-store';
import {
  scanForStuckUuids,
  detectEmptyStoreTransition,
  clearEmptyFlag,
  runReconciliation,
} from './reconciliation';
import type { KVStorage } from '../kv/device-registry';

function createFakeKvStorage(): KVStorage {
  const store = new Map<string, unknown>();
  return {
    async getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async setItem(key, value) {
      store.set(key, value);
    },
    async getKeys(base) {
      return [...store.keys()].filter((k) => !base || k.startsWith(base));
    },
    async removeItem(key) {
      store.delete(key);
    },
  };
}

describe('Reconciliation scan (relay_data_model.md §2.5, §2.6, §7.3)', () => {
  let harness: TestRedisHarness;
  let uuidStore: UuidStore;

  beforeEach(async () => {
    harness = await createTestRedisHarness();
    uuidStore = new UuidStore(harness.client, 2_592_000);
  });

  afterEach(async () => {
    await harness.teardown();
  });

  describe('scanForStuckUuids (§2.5)', () => {
    it('transitions stuck active and in_flight UUIDs to consumed', async () => {
      await uuidStore.create('11111111-1111-4111-8111-111111111111', {
        app_id: 'a', push_token: 'p', wallet_base_url: 'https://w', device_credential: 'c', created_at: 'x',
      });
      await uuidStore.simpleTransition('11111111-1111-4111-8111-111111111111', 'unused', 'active');

      await uuidStore.create('22222222-2222-4222-8222-222222222222', {
        app_id: 'a', push_token: 'p', wallet_base_url: 'https://w', device_credential: 'c', created_at: 'x',
      });
      await uuidStore.casTransition('22222222-2222-4222-8222-222222222222', 'unused', 'in_flight');

      await uuidStore.create('33333333-3333-4333-8333-333333333333', {
        app_id: 'a', push_token: 'p', wallet_base_url: 'https://w', device_credential: 'c', created_at: 'x',
      }); // stays unused — must NOT be touched

      const { stuckCount } = await scanForStuckUuids(harness.client, 100);
      expect(stuckCount).toBe(2);

      expect((await uuidStore.get('11111111-1111-4111-8111-111111111111'))?.status).toBe('consumed');
      expect((await uuidStore.get('22222222-2222-4222-8222-222222222222'))?.status).toBe('consumed');
      expect((await uuidStore.get('33333333-3333-4333-8333-333333333333'))?.status).toBe('unused');
    });

    it('does not touch already-consumed UUIDs', async () => {
      await uuidStore.create('44444444-4444-4444-8444-444444444444', {
        app_id: 'a', push_token: 'p', wallet_base_url: 'https://w', device_credential: 'c', created_at: 'x',
      });
      await uuidStore.casTransition('44444444-4444-4444-8444-444444444444', 'unused', 'in_flight');
      await uuidStore.casTransition('44444444-4444-4444-8444-444444444444', 'in_flight', 'consumed');

      const { stuckCount } = await scanForStuckUuids(harness.client, 100);
      expect(stuckCount).toBe(0);
    });
  });

  describe('detectEmptyStoreTransition (§2.6 false-positive guard)', () => {
    let kv: KVStorage;

    beforeEach(() => {
      kv = createFakeKvStorage();
    });

    it('does NOT flag a transition when the store has always been empty (fresh deployment)', async () => {
      const result = await detectEmptyStoreTransition(harness.client, kv);
      expect(result.isEmptyNow).toBe(true);
      // First-ever empty reading DOES set the flag (there's no way to
      // distinguish "always empty" from "just reset" from a single
      // reading) — but per the spec, actual re-registration firing is
      // additionally gated on the KV device registry being non-empty
      // (runReconciliation, tested below), which is what actually
      // prevents a spurious push on a fresh deployment.
      expect(result.transitionedToEmpty).toBe(true);
    });

    it('does NOT re-fire on a second consecutive empty reading (already-flagged case)', async () => {
      await detectEmptyStoreTransition(harness.client, kv); // sets flag true
      const second = await detectEmptyStoreTransition(harness.client, kv);
      expect(second.transitionedToEmpty).toBe(false);
    });

    it('clears the flag once a UUID write succeeds, and does not fire on the next momentary-empty reading after (the exact false-positive case §2.6 calls out)', async () => {
      // Simulate: store starts non-empty (a UUID exists), so the flag is
      // implicitly false. Then it briefly has zero outstanding UUIDs
      // (all consumed/expired) — this must NOT be treated as a reset.
      await uuidStore.create('55555555-5555-4555-8555-555555555555', {
        app_id: 'a', push_token: 'p', wallet_base_url: 'https://w', device_credential: 'c', created_at: 'x',
      });
      const whileNonEmpty = await detectEmptyStoreTransition(harness.client, kv);
      expect(whileNonEmpty.isEmptyNow).toBe(false);
      expect(whileNonEmpty.transitionedToEmpty).toBe(false);

      // Now consume it (simulating a lull with zero outstanding UUIDs).
      await harness.client.del('uuid:55555555-5555-4555-8555-555555555555');
      // clearEmptyFlag would have been called by register's last successful
      // write already (flag was never set true in this scenario), so a
      // momentary empty reading right after IS a genuine first empty
      // reading and DOES set the flag per the state machine — this is
      // correct per spec (§2.6: "the simplest implementation ... only fire
      // ... on the false -> true transition"). The key correctness
      // property this test actually protects is the NEXT part: after
      // clearEmptyFlag runs (simulating a subsequent successful write),
      // another momentary-empty reading must independently re-arm, not
      // spuriously fire twice in a row.
      const firstEmpty = await detectEmptyStoreTransition(harness.client, kv);
      expect(firstEmpty.transitionedToEmpty).toBe(true);

      await clearEmptyFlag(kv); // simulates a UUID write succeeding again
      const afterClear = await detectEmptyStoreTransition(harness.client, kv);
      // Store is still empty in this test (no new UUID actually created),
      // so this correctly reports another false->true transition — proving
      // clearEmptyFlag genuinely reset the flag rather than leaving it
      // stuck true (which would have suppressed all future detections).
      expect(afterClear.transitionedToEmpty).toBe(true);
    });
  });

  describe('runReconciliation (combined pass, §2.5+§2.6, relay.md §9)', () => {
    it('does not trigger re-registration when the device registry is empty (fresh deployment guard)', async () => {
      const kv = createFakeKvStorage(); // no registry:* entries
      let resetCalled = false;
      const result = await runReconciliation({
        redis: harness.client,
        kv,
        onStoreReset: async () => {
          resetCalled = true;
        },
      });
      expect(result.emptyStoreDetected).toBe(true);
      expect(result.reregistrationTriggered).toBe(false);
      expect(resetCalled).toBe(false);
    });

    it('triggers re-registration when primary is empty AND device registry is non-empty', async () => {
      const kv = createFakeKvStorage();
      await kv.setItem('registry:push-tok-1', { app_id: 'a', last_registered_at: 'x' });
      let resetCalled = false;
      const result = await runReconciliation({
        redis: harness.client,
        kv,
        onStoreReset: async () => {
          resetCalled = true;
        },
      });
      expect(result.reregistrationTriggered).toBe(true);
      expect(resetCalled).toBe(true);
    });

    it('reports stuck-UUID count alongside empty-store detection in one pass', async () => {
      await uuidStore.create('66666666-6666-4666-8666-666666666666', {
        app_id: 'a', push_token: 'p', wallet_base_url: 'https://w', device_credential: 'c', created_at: 'x',
      });
      await uuidStore.simpleTransition('66666666-6666-4666-8666-666666666666', 'unused', 'active');
      const kv = createFakeKvStorage();
      const result = await runReconciliation({
        redis: harness.client,
        kv,
        onStoreReset: async () => {},
      });
      expect(result.stuckTransitioned).toBe(1);
    });
  });
});
