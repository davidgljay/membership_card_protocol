# Code-vs-Spec Review: `code-relay`

**Unit:** `specs/object_specs/relay.md` + `specs/object_specs/relay_data_model.md` vs. `relay/src/`
**Excluded:** `relay_serverless_old/` (legacy Cloudflare Workers migration — not checked against; spec was also scanned for accidental leftover descriptions of that architecture, see Finding 5).

## Summary

The relay code is in very good alignment with both specs. The headline question this review was scoped to answer — whether `POST /ohttp/{target_id}` (added to `relay.md §7.9` / `relay_data_model.md §6.4` today, Phase 2 Fix #6) actually exists in code — resolves the opposite way from the assumed default: **the endpoint is fully implemented already.** This is not the "code needs to implement this" gap that was flagged as likely; instead there are three smaller, real divergences in how the endpoint's contract is documented vs. implemented, plus a few unrelated minor items found while reading the rest of `relay/src/`.

No security-relevant divergences were found. Nothing here needs to be escalated to David under the "code is right, spec is wrong on a load-bearing/security field" clarification checkpoint.

---

## Finding 1 — OHTTP endpoint exists and matches the spec's core contract (informational, not a divergence)

`relay/src/routes/ohttp.ts` (route handler) and `relay/src/utils/oblivious_targets.ts` (target registry loader/resolver) both exist, and `relay/src/router.ts:38` wires `POST /ohttp/:target_id` to the handler. `relay/src/server.ts:18` calls `loadObliviousTargets(process.env.OBLIVIOUS_TARGETS_PATH)` at startup, before `runStartupChecks()`.

Core behavior matches `relay.md §7.9` and `relay_data_model.md §6.4` closely:
- Resolves `target_id` in the registry; forwards the raw body unread/unparsed via outbound HTTPS POST to `ohttp_gateway_url`, preserving `Content-Type`.
- Passes the destination's status and body back to the device unmodified.
- Registry is a JSON file (`ObliviousTargetsFile { targets: ObliviousTarget[] }`) with `target_id` + `ohttp_gateway_url`, validated at startup (unique `target_id`, `ohttp_gateway_url` must start with `https://`) — matches `relay_data_model.md §6.4`'s schema and validation rules exactly.

**Conclusion for this side of the review: code is correct and ahead of what the task assumed.** The three items below are the actual, narrower divergences.

## Finding 2 — Error code strings don't match between spec and code (spec update needed)

`relay.md §7.9` and the master error table in `relay.md §10` specify:
- `404 UNKNOWN_TARGET` — target_id not found
- `502 BAD_GATEWAY` — destination unreachable

The actual code (`relay/src/routes/ohttp.ts:12,18,34`) returns:
- `404 NOT_FOUND` (both for a missing `target_id` path param and an unknown `target_id`)
- `502 GATEWAY_UNREACHABLE`

Additionally, `relay.md §10`'s master error-code table was never updated with *any* OHTTP-specific codes (neither the spec's own `UNKNOWN_TARGET`/`BAD_GATEWAY` nor the code's actual `NOT_FOUND`/`GATEWAY_UNREACHABLE` appear there) — only §7.9's local table has them, and even that one disagrees with the code.

**Which side is correct:** the code is the actual deployed behavior; any caller integrating today gets `NOT_FOUND`/`GATEWAY_UNREACHABLE`, not the spec's names. Recommend updating `relay.md` §7.9 and §10 to document the strings the code actually returns, rather than changing the code — this is a very recently built endpoint, so there's no compatibility cost either way, but changing the spec text is the smaller edit. Not security-relevant (these are just error-code label strings; the status codes themselves — 404/502 — do match).

## Finding 3 — `OBLIVIOUS_TARGETS_PATH` is documented as required but implemented as optional (spec update needed)

`relay_data_model.md §9` (Environment Variables table) lists `OBLIVIOUS_TARGETS_PATH` as **Required: Yes**, with no default, in the same row style as `APP_REGISTRY_PATH` (also Required: Yes, which *is* enforced — `relay/src/server.ts:12-15` calls `process.exit(1)` if `APP_REGISTRY_PATH` is unset).

The code deliberately treats `OBLIVIOUS_TARGETS_PATH` as **optional**. From `relay/src/utils/oblivious_targets.ts:15-21`:
> "This feature is optional — if the env var is unset, the registry stays empty and every target_id lookup returns undefined... Unlike loadAppRegistry, a missing env var here is NOT a fatal startup error."

`relay/src/server.ts:18` calls `loadObliviousTargets(process.env.OBLIVIOUS_TARGETS_PATH)` unconditionally, with no prior existence check or `process.exit`. `relay/.env.example:11-12` reinforces this, showing the var commented out with `# Optional — enables POST /ohttp/{target_id}... Unset = feature disabled.`

**Which side is correct:** this reads as an intentional design decision baked into the code (the comment explicitly contrasts it with the required `APP_REGISTRY_PATH` pattern) — deploying the relay without OHTTP forwarding configured is a legitimate, supported configuration, and making it a hard startup failure would be a regression. Recommend fixing the spec's §9 table to mark `OBLIVIOUS_TARGETS_PATH` as **Required: No**, matching the code's actual (and, on inspection, sensible) behavior. Not security-relevant — worst case of the current code behavior is the feature being silently disabled if the operator forgets to set the var, which is a deployment/ops concern, not an auth or data-exposure one.

## Finding 4 — File-path citation typo: hyphen vs. underscore (spec update needed)

Both specs cite the target-registry file as `relay/src/utils/oblivious-targets.ts` (hyphenated):
- `relay.md §7.9` (line 566, "Implementation" subsection)
- `relay.md §2` relationship table isn't affected, but `relay_data_model.md §6.4` also uses the hyphenated form

The actual file is `relay/src/utils/oblivious_targets.ts` (underscore), consistent with the rest of the codebase's naming convention (`ws_connections.ts`, `sse_connections.ts`, `wallet_clearance.ts` all use underscores, not hyphens). This is a small citation error, likely introduced when the Fix #6 spec text was drafted. Recommend a one-word fix in both files: `oblivious-targets.ts` → `oblivious_targets.ts`.

## Finding 5 — No leftover serverless-architecture description found (confirms spec is clean)

Per the task's request to check whether `relay.md` accidentally still describes the old Cloudflare Workers/Durable Objects/KV architecture anywhere outside historical changelog context: grepped both specs for `Durable Object`, `Cloudflare`, `Workers`, `KV`, `Nitro`, `Redis Cloud`, `Upstash`. Every hit is confined to the version-history preamble (the "Amends v0.8 →..." blocks at the top of each file) or explicit "this is what changed and why" changelog prose — none of it describes current, active behavior. No fix needed here.

## Finding 6 (minor, code hygiene, not a spec divergence) — Stale comment in `ws_connections.ts`

`relay/src/utils/ws_connections.ts:14-18` contains a comment claiming:
> "The current relay.md §7.3 text describes UUID-keyed addressing instead, but that's tied specifically to the Cloudflare Durable Object model (idFromName(uuid)) and doesn't apply to this single-process deployment..."

This is now stale: `relay.md §7.3` was corrected during this same initiative (Phase 2, per the v0.9 changelog at the top of `relay.md`) to already describe `device_credential`-keyed addressing, matching the code. The comment describes a spec/code conflict that no longer exists. Not a spec-vs-code inconsistency (spec and code agree), but worth a small code cleanup so a future reader doesn't get confused chasing a resolved discrepancy. Flagging for the consolidated fix list as an optional code comment cleanup, not a spec change.

## Finding 7 (minor, code hygiene, not a spec divergence) — Misleading "Stub" comment in `reregistration.ts`

`relay/src/utils/reregistration.ts:7` has the comment `// Stub — implemented in Phase 4 Step 13` directly above a fully-implemented `runReregistrationCheck()` function that matches `relay.md §9` behavior exactly (empty-store detection, SQLite lookup, `relay_reregistration_requested` push payload with `relay_id`). The comment is leftover from an earlier build phase and is inaccurate — the function is not a stub. No functional or spec impact; flagging as a trivial comment cleanup.

---

## Recommended resolutions (for the Phase 3 consolidated fix list)

| # | Item | Side to fix | Type |
|---|---|---|---|
| 1 | OHTTP endpoint existence | — | Informational: confirmed implemented, no fix needed |
| 2 | Error code strings (`UNKNOWN_TARGET`/`BAD_GATEWAY` vs. `NOT_FOUND`/`GATEWAY_UNREACHABLE`) | Spec (`relay.md` §7.9, §10) | Update spec text to match code's actual strings |
| 3 | `OBLIVIOUS_TARGETS_PATH` required-vs-optional | Spec (`relay_data_model.md` §9) | Update spec table to "Required: No" |
| 4 | `oblivious-targets.ts` vs `oblivious_targets.ts` citation | Spec (`relay.md` §7.9, `relay_data_model.md` §6.4) | Fix filename typo (hyphen → underscore) |
| 5 | Leftover serverless description check | — | None found; no action |
| 6 | Stale comment in `ws_connections.ts` | Code (comment only) | Optional cleanup |
| 7 | Misleading "Stub" comment in `reregistration.ts` | Code (comment only) | Optional cleanup |

No items in this unit meet the "escalate to David" bar (nothing security-relevant, nothing touching an auth boundary or a load-bearing field where code is right and spec is wrong).
