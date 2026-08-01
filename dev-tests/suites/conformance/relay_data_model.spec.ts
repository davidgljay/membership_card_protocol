/**
 * `specs/object_specs/relay_data_model.md` object-spec conformance, against
 * the live dev relay. Adapted from
 * integration_tests/suites/conformance/relay_data_model.spec.ts.
 *
 * Real adaptation, not a mechanical port: the original suite reads
 * `env/relay/apps.json` / `oblivious_targets.json` directly off the host
 * filesystem, since docker-compose bind-mounts them into the local relay
 * container. The live dev relay runs on DigitalOcean App Platform, which has
 * no bind mounts -- its config is materialized from the `APP_REGISTRY_JSON`/
 * `OBLIVIOUS_TARGETS_JSON`-equivalent secrets at container start (see
 * relay/DEPLOYMENT.md and relay/scripts/materialize-secrets.mjs), and
 * dev-tests has no host-level access to read that back. This suite
 * therefore:
 *
 *  - Drops every check that required reading the registry file's full
 *    contents directly (§6.1/§6.3/§6.4 schema validation against the raw
 *    JSON, and the "referenced credential files exist" check) -- those are
 *    validated once, out-of-band, when the operator sets up
 *    `APP_REGISTRY_JSON`/`OBLIVIOUS_TARGETS_JSON` per relay/DEPLOYMENT.md;
 *    they are not re-validated per dev-tests run.
 *  - Keeps every check that's purely behavioral (HTTP requests against the
 *    live relay), using one already-known app_id/target_id supplied via
 *    `DEV_RELAY_KNOWN_APP_ID`/`DEV_RELAY_KNOWN_TARGET_ID` config (see
 *    dev-tests/.env.example) instead of reading the first entry out of a
 *    locally-readable file.
 *
 * Requires DEV_RELAY_URL, DEV_RELAY_KNOWN_APP_ID, and
 * DEV_RELAY_KNOWN_TARGET_ID to be set (see dev-tests/.env.example) --
 * DEV_RELAY_KNOWN_APP_ID/DEV_RELAY_KNOWN_TARGET_ID must reference entries
 * that actually exist in the live relay's real registry config.
 */

import { describe, it, expect, beforeAll } from 'vitest';

const RELAY_BASE_URL = (process.env.DEV_RELAY_URL ?? '').replace(/\/$/, '');
const KNOWN_APP_ID = process.env.DEV_RELAY_KNOWN_APP_ID ?? '';
const KNOWN_TARGET_ID = process.env.DEV_RELAY_KNOWN_TARGET_ID ?? '';

describe('relay_data_model.md object-spec conformance (live dev deployment)', () => {
  beforeAll(() => {
    if (!RELAY_BASE_URL || !KNOWN_APP_ID || !KNOWN_TARGET_ID) {
      throw new Error(
        'relay_data_model.spec.ts requires DEV_RELAY_URL, DEV_RELAY_KNOWN_APP_ID, and ' +
          'DEV_RELAY_KNOWN_TARGET_ID -- see dev-tests/.env.example.',
      );
    }
  });

  describe('§6: App Registry Config (behavioral checks only — see file header)', () => {
    it('§6: Relay honors app_id from config in responses (behavioral check)', async () => {
      const response = await fetch(`${RELAY_BASE_URL}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: KNOWN_APP_ID, push_token: `dev-tests-token-${Date.now()}` }),
      });
      expect([200, 400]).toContain(response.status); // 200 = success, 400 = validation error, not 404 (unknown app)
    });

    it('§6.3: Unknown app_id is rejected (behavioral check)', async () => {
      const unknownAppId = 'unknown-app-that-does-not-exist-' + Date.now();
      const response = await fetch(`${RELAY_BASE_URL}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: unknownAppId, push_token: 'dev-tests-token' }),
      });
      expect([400, 404]).toContain(response.status);
    });
  });

  describe('§6.4: Oblivious Target Registry Config (behavioral checks only — see file header)', () => {
    it('§6.4 + relay.md §7.9: Unknown target_id returns 404 (behavioral check)', async () => {
      const unknownTargetId = '0x' + 'ab'.repeat(32);
      const response = await fetch(`${RELAY_BASE_URL}/ohttp/${unknownTargetId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enc: 'bm90LXJlYWw', ciphertext: 'bm90LXJlYWw' }),
      });
      expect(response.status).toBe(404);
    });

    it('§6.4 + relay.md §7.9: Known target_id is registered and can be called (behavioral check)', async () => {
      const response = await fetch(`${RELAY_BASE_URL}/ohttp/${KNOWN_TARGET_ID}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enc: 'bm90LXJlYWw', ciphertext: 'bm90LXJlYWw' }),
      });
      // Should not be 404 (unknown target) -- may be 502 (gateway error) or
      // other, but NOT 404.
      expect(response.status).not.toBe(404);
    });
  });

  describe('§9: Environment Variables (proxy checks — see file header)', () => {
    it('§9: relay is reachable and healthy (proxy for REDIS_URL/DB_PATH/APP_REGISTRY_PATH all being set correctly)', async () => {
      const res = await fetch(`${RELAY_BASE_URL}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status?: string; redis?: string; sqlite?: string };
      expect(body.status).toBe('ok');
      expect(body.redis).toBe('ok');
      expect(body.sqlite).toBe('ok');
    });
  });

  describe('§2-5, §7: Internal stores (NOT TESTABLE remotely — same gap as the local suite, worse)', () => {
    it.todo('§2-4, §7: Redis-based stores — no remote access to the dev Managed Redis instance', () => {
      // Same fundamental gap as integration_tests' version of this suite
      // (no host port mapping locally), compounded here: DEV_TESTS have no
      // network path to the dev Managed Redis instance at all (see
      // relay/DEPLOYMENT.md). Covered behaviorally by
      // matrix-relay/notification_relay.spec.ts's dev-tests counterpart.
    });

    it.todo('§5: SQLite Device Registry — no exposed HTTP read endpoint, and no persistence guarantee on App Platform', () => {
      // Same HTTP-endpoint gap as the local suite, plus relay/DEPLOYMENT.md's
      // "Known limitations": the device registry doesn't even persist across
      // redeploys on App Platform today, so this is doubly out of scope
      // until that gap is resolved.
    });
  });
});
