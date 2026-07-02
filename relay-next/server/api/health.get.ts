// Trivial route used to validate the Nitro scaffold builds under both the
// `cloudflare` and `node-server` presets (Phase 1, step 1.1 of
// plans/relay-serverless-migration-implementation-plan.md).
//
// This is NOT the real /health endpoint from specs/object_specs/relay.md
// §7.7 — that requires the ported Redis Cloud storage layer, which is
// Phase 2 scope. This stub only proves the build/deploy pipeline works.
export default defineEventHandler(() => {
  return {
    status: 'ok',
    note: 'relay-next scaffold — not the production /health endpoint (see Phase 2)',
  };
});
