# suites/

Integration test suites, one file per process spec in `specs/process_specs/`,
organized by wave:

- `core/` — Wave 1: card lifecycle (card signing, offering/acceptance,
  validation, updates, open offers)
- `matrix-relay/` — Wave 2: matrix room membership/attestation, message
  routing, notification relay, room discovery
- `extended/` — Wave 3: remaining process specs (migration, backup/recovery,
  log auditing, oblivious transport, policy/subcard specs, DNS governance)
- `conformance/` — object-spec conformance checks not already covered by a
  named process suite

## Conventions

Established in Phase 3 Step 3.1 (first lifecycle test) and Phase 4 Step 4.1
(first matrix flow test). Documented here as each pattern-setting suite
lands.
