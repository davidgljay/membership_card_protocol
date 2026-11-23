# Notary branch: dependency audit and attack-surface review

Date: 2026-11-22. Branch `notary`. Nothing in the repository was changed to produce this; the experiments ran in scratch copies.

## 1. What ships, and what is trusted

| Component | Language | What runs in production | Trust level |
|---|---|---|---|
| `notary-runtime` (broker, worker, crypto, attest, cards) | Rust | Inside the Nitro enclave | **Highest.** Holds job and identity keys; its measurement (PCR0) is what users trust. |
| WASM templates (`templates/*`) | Rust to wasm32 | Inside the enclave, under wasmi | Untrusted code, sandboxed; its dependencies run inside the guest. |
| `notary/host` | TypeScript (Nitro) | Operator's host, outside the enclave | Untrusted by design: the enclave re-checks everything it gets. A compromised host can stall or lie to the enclave, not read keys. |
| `wallet-sdk/notary`, `verifier/notary`, `notary/attestation-ts` | TypeScript | In users' wallets and verifiers | **High.** A flaw here changes what users accept as valid. |
| `notary/e2e`, `notary/vectors-tools`, test crates | Mixed | Never shipped | Test only. |

The enclave and the wallet/verifier libraries are where a dependency flaw does the most damage, so they get the strictest treatment below.

## 2. Inventory

**Rust** (`notary/Cargo.lock`): 18 workspace crates, 146 external crates, all from crates.io. Licences are all permissive (MIT/Apache-2.0/BSD/Zlib/Unlicense); one crate is `MIT OR Apache-2.0 OR LGPL-2.1-or-later`, a dual licence we take under MIT.

The enclave binary's closure is **106 external crates** (normal dependencies, host target). The ones that matter:

| Direct dependency | Used for | Transitive crates it brings | Maturity |
|---|---|---|---|
| `hpke` 0.15.1 (exact pin) | job and handoff keys (X-Wing HPKE) | 56 | pre-1.0 |
| `p384` 0.14 | Nitro attestation signatures | 53 | RustCrypto |
| `p256` 0.14 | registry and governance P-256 checks | 52 | RustCrypto |
| `x-wing` 0.1.1 (exact pin) | X-Wing KEM (via `hpke`) | 44 | pre-1.0 |
| `ml-kem` 0.3.4 (exact pin) | private output messages (ADR-007) | 37 | pre-1.0 |
| `ml-dsa` 0.1.2 (exact pin) | ML-DSA-44 signatures | 36 | pre-1.0 |
| `x509-cert`, `der`, `spki`, `ciborium` | parsing the Nitro attestation (G5: only here) | 12 to 32 | |
| `wasmi` 2.0.0 (exact pin) + `wasmparser` 0.228 | running and admitting templates | 21 + 5 | |
| `aes-gcm`, `chacha20poly1305`, `hkdf`, `sha2`, `sha3` | symmetric crypto and hashing | | RustCrypto |
| `seccompiler`, `nix`, `libc` | the enclave's sandbox | 1 to 5 | |
| `regex` | the predicate regex subset | 5 | |
| `memsec`, `zeroize` | memory locking and wiping | | |

The post-quantum crates (`ml-dsa`, `ml-kem`, `x-wing`, `hpke`) are all pre-1.0 and exactly pinned, which is right for the crates that decide security. I did **not** check whether independent audits of these versions have been published; that is a gap in this review (see section 5).

**JavaScript** (`pnpm`, `^` ranges for most): production closure by package:

| Package | Production closure | Notes |
|---|---|---|
| `notary/host` | **382** | 322 of these exist only because `nitropack` is a production dependency. Without it, 60. |
| `notary/e2e` | 39 | test only |
| `notary/attestation-ts` | 14 | ships in wallets |
| `wallet-sdk` | 17 | ships in wallets |
| `verifier` | 6 | ships in verifiers (`@noble/*`) |

What reaches production in the host is the **bundled** `.output` (3.7 MB, no `node_modules`): the Nitro runtime, `ioredis` (through `unstorage`), `@hpke/*`, `@noble/*` and our code. `viem` joins it when the chain clients are wired in.

## 3. Findings

### Vulnerabilities

- **Rust:** 0 advisories for all 146 crates (queried against OSV, which mirrors RustSec). `cargo-audit` and `cargo-deny` are not installed, so this was an OSV lookup, not RustSec's own tool; I did not check for unmaintained or yanked crates.
- **notary/host (`pnpm audit --prod`):** 2 moderate, `glob` (AbortSignal bypass) and `minimatch` (ReDoS), both through `nitropack > @vercel/nft`. They sit in the build tool and **do not ship** in the bundle.
- **wallet-sdk:** none. **attestation-ts, verifier:** none in their own closures.
- **`membership_card_verifier` workspace (audited from its root):** 20 findings (14 high: `fast-uri`, `brace-expansion`, `nanoid`; plus `protobufjs`), reached through `packages/verifier-ipfs-provider`'s own tooling. They are **not in the notary closure**: the host's lockfile records `verifier-ipfs-provider` with no dependencies, and `pnpm audit --prod` on the host does not show them. (An earlier draft of this report said the package could be dropped from the host image; that was wrong, see finding 4.)

### Process risks (higher than any listed advisory)

1. **The host image resolves dependencies at build time.** `Dockerfile.host` runs `pnpm install --frozen-lockfile=false` on a copy of `notary/host` with no lockfile, so the versions inside the shipped bundle are whatever the `^` ranges resolve to that day. The same flag is in `Dockerfile.e2e` and `build-ts-deps.sh`. CI uses `--frozen-lockfile`, so what CI tests is not what the image contains. This is the most important finding.
2. **Rust image builds are not forced to the lockfile.** `Dockerfile.runtime-sim` copies `Cargo.lock` but builds without `--locked`. The real enclave image (EIF) is not built yet; its PCR0 should come from a build that cannot drift.
3. **Base images are floating tags** (`rust:1.96`, `node:22-slim`, `debian:trixie-slim`), not digests.
4. **`verifier-ipfs-provider` stays.** It looked unused, but `app-sdk` imports `FilebaseIpfsProvider` from it (`CardVerifier.ts`) and lists it as a dependency, and the wallet SDK depends on `app-sdk`, so it is in the host's closure. It has no runtime dependencies of its own, so it adds little surface. Removing it would be a change to `app-sdk`, outside the notary branch.

### Surface: where it is larger than it needs to be

5. `nitropack` is a production dependency of the host but a build tool (322 of 382 production packages).
6. Two digest stacks in the enclave: `sha2` 0.10 and 0.11, `sha3` 0.10 and 0.12, with duplicate `digest`, `block-buffer`, `crypto-common`, `keccak` and `cpufeatures`.
7. The host's OHTTP gateway imports the `hpke-js` meta-package, which bundles algorithms it never uses (X448, ChaCha20-Poly1305).
8. Two lines of `@noble/hashes` (1.8 and 2.0) and `@noble/curves` (1.9 and 2.0) in the host closure.
9. `x509-cert`, `der`, `spki`, `ciborium` and `p384` are compiled into every build of `notary-attest`, including the simulator, which does not parse real Nitro attestations.

## 4. Measured reductions (experiments in scratch copies; the repository is unchanged)

| Change | Result | Verified |
|---|---|---|
| Unify the enclave on `sha2` 0.11 and `sha3` 0.12 | External crates in the enclave closure **106 to 98** (-8). It needed `sha3` added to `notary-cards` and `notary-messaging` and the `oid` feature on `sha2` in `notary-attest`. | `cargo check` clean; tests for `notary-crypto`, `-types`, `-cards`, `-messaging`, `-attest` pass, except one `notary-types` vector test that needs a fixture outside the scratch copy. Not run: the full workspace and the e2e. |
| Replace `hpke-js` with `@hpke/core` + `@hpke/dhkem-x25519` in the OHTTP gateway | Host bundle **869 kB to 812 kB**; `@hpke/dhkem-x448` and `@hpke/chacha20poly1305` leave the bundle | Builds. Not run: the host's OHTTP tests and an end-to-end request. |
| Move `nitropack` to `devDependencies` (host) | Declared production closure **382 to 60**; the two `glob`/`minimatch` findings leave `pnpm audit --prod` | Computed from the lockfile graph. The shipped bundle does not change (Nitro's runtime is bundled either way). |
| Replace `memsec` with direct `libc::mlock` | One crate; not worth the new `unsafe` | Measured only |

## 5. Recommendations, in order

**Do first (cheap, high value):**
1. Build the host image from the lockfile: `pnpm install --frozen-lockfile`, with `notary/pnpm-lock.yaml` copied into the build. Same for `Dockerfile.e2e` and `build-ts-deps.sh`.
2. Add `--locked` to every `cargo build` in `deploy/`; for the EIF, vendor the crates (`cargo vendor`) and build offline so PCR0 is reproducible from the source tree.
3. Pin base images by digest.
4. Move `nitropack` to `devDependencies`.

**Then (measured, low risk):**
6. Unify on `sha2` 0.11 and `sha3` 0.12 (saves 8 crates in the enclave). Run the full Rust workspace and the e2e, since hashing touches every vector.
7. Replace `hpke-js` with the two granular `@hpke/*` packages in the gateway; run the host tests.
8. Align `@noble/*` to one major version per package where the dependents allow.

**Policy, so the surface does not grow back:**
9. Add `cargo-deny` (advisories, `bans` on duplicate versions for the crypto crates, licence allow-list, sources limited to crates.io) and run it in `notary-ci.yml`. Consider `cargo-vet` for the crates in the enclave closure, with the PQ crates as the first to audit.
10. Run `pnpm audit --prod` per shipped package in CI; fail on high.
11. Feature-gate `x509-cert`, `der`, `spki`, `ciborium` and `p384` in `notary-attest` behind an `aws` feature, so the simulator runtime and its images do not carry them.
12. Pin the host's production dependencies exactly (the Rust crypto crates already are), with Renovate or similar for reviewed bumps.

**Not recommended:** hand-rolling ABI encoding or transaction signing instead of `viem` for the chain clients (more risk than the dependency it removes); replacing `ioredis` (the KV driver it serves is needed); removing `regex` (the predicate spec needs it).

## 6. Limits of this review

- Advisory data came from `pnpm audit` and OSV; I did not install `cargo-audit` or `cargo-deny`.
- I did not read the source of any dependency, check for typosquats or maintainer changes, or check whether the pre-1.0 PQ crates have published independent audits.
- Dev dependencies (vitest, eslint, and so on) were not audited; they do not ship.
- The Nitro enclave's real image (EIF) does not exist yet, so its build reproducibility is a recommendation, not a finding.
- The wasm guest crates (`templates/*`) were not separately measured.

## 7. Applied 2026-11-23

Done, from section 5: locked installs in `Dockerfile.host`, `Dockerfile.e2e` and `build-ts-deps.sh` (`--frozen-lockfile`, each workspace's root files copied into the image); `cargo build --locked` in `Dockerfile.runtime-sim`; base images (`node`, `rust`, `debian`, `redis`, `socat`) pinned by digest; `nitropack` moved to `devDependencies` (`pnpm audit --prod` on the host: no known vulnerabilities). Recommendation 4 (stop building `verifier-ipfs-provider`) was **not** applied: `app-sdk` needs it (see finding 4). `.github/dependabot.yml` added so updates arrive as reviewed pull requests; the exactly pinned crypto crates and `wasmi` are ignored there on purpose. Not applied: `sha2`/`sha3` unification, the `@hpke/*` change, `cargo-deny`, `pnpm audit` in CI.

**Update (the `rpc` clients, same day):** wiring the production chain clients adds `viem` to the host bundle, which grew from 0.81 MB to 1.81 MB (and brings `ws`, `ox`, `abitype`). `ws`'s optional native modules (`bufferutil`, `utf-8-validate`) are aliased to a throwing stub (`notary/host/stubs/not-installed.mjs`) because the host bundles everything; the WebSocket transport is never used. Importing only `viem`'s HTTP transport from subpaths may shrink this; not tried.
