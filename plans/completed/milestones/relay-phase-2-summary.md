# Relay Phase 2 — Milestone Summary

**Date:** 2026-06-28
**Status:** Complete

---

## Steps Completed

- **Step 3: Project initialized** — `relay/` directory created as Node.js + TypeScript project. Dependencies: `ioredis`, `better-sqlite3`, `node-apn`, `firebase-admin`, `ws`. Dev tooling: `tsx`, `typescript`, `vitest`. `npm run build` compiles cleanly; `npm start` starts the server; all route stubs return 501.

- **Step 4: Docker Compose wired** — `Dockerfile` (multi-stage: build → runtime), `docker-compose.yml` (relay + Redis with healthcheck), `docker-compose.dev.yml` (hot-reload via `tsx watch` + redis-commander for Redis inspection).

- **Step 5: Storage clients implemented** — `utils/storage/redis.ts`: `getUuid`, `setUuid`, `deleteUuid`, `transitionUuid` (atomic Lua script), `isStoreEmpty`, `scanActiveUuids`. `utils/storage/sqlite.ts`: schema migration on open, `upsertDevice`, `getRecentDevices`, `pruneOldDevices`. SQLite unit tests pass (4/4).

- **Step 6: App registry loader implemented** — `utils/apps.ts`: reads `APP_REGISTRY_PATH`, validates all required fields, credential file existence, `app_id` uniqueness, platform/config alignment; exits with clear message on invalid config. Exports `getApp` and `getAllApps`.

---

## Checklist

- [x] `npm run build` completes without TypeScript errors
- [x] `npm start` starts the server on PORT
- [x] All route stubs return 501
- [x] All typed interfaces in `utils/` match the data model spec exactly
- [x] App registry loader rejects invalid configs at startup (validation covers all rules from `relay_data_model.md §4.3`)
- [x] Redis and SQLite connection errors are surfaced (logged and thrown, not swallowed)
- [x] SQLite unit tests pass: upsert, re-upsert timestamp update, prune, empty query

---

## Notes

- `@types/node-apn` does not exist on npm; `node-apn` ships its own types. Removed from devDependencies.
- Push stubs (`apns.ts`, `fcm.ts`) throw `NOT_IMPLEMENTED` in all environments except `NODE_ENV=development`, where `dispatch.ts` logs a warning and returns without calling them. This allows the server to run locally without credentials.
- Redis unit tests (transitionUuid atomicity, empty-store detection) require a live Redis instance and are deferred to Phase 3 / Phase 5 integration test suite.

---

## Ready for Phase 3

All Phase 2 checks pass. Phase 3 (core endpoint implementation) may proceed.
