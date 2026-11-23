# notary

Digital Notaries: a notary runs a community's analysis or issues a derived card inside an enclave, and anyone can check
what it did from public data. The specs are `specs/object_specs/notary_host.md`, `notary_runtime.md`, the process specs
`notary_lifecycle.md`, `notary_replication_and_recovery.md` and `derived_card_revocation_propagation.md`,
and ADR-013 in `specs/ARCHITECTURE.md`. Running a notary in production: [OPERATOR.md](OPERATOR.md).

## What is in this directory

| Path | What it is |
|---|---|
| `runtime/` | The enclave side, in Rust: `crates/notary-{types,crypto,attest,cards,admission,worker,broker,messaging}` and the `notary-runtime` binary (`--mode broker` and `--mode worker`). `benches/capacity` is the capacity benchmark. |
| `templates/` | The audited programs a community activates with a policy and no code: `aggregate`, `vote`, `vote-yna`, `derive` (compiled to WASM, committed under `templates/modules/`). See `templates/README.md`. |
| `guest/`, `lint/` | The program ABI crate and the linter the runtime's admission uses. |
| `sim/` | The simulated enclave service (`fake-enclave`): attestations under a fixed **test** root. Never for production. |
| `host/` | The notary host (nitropack, TypeScript): the operator's process outside the enclave. Production clients for the chain, EAS and IPFS are in `host/src/chain`, `host/src/eas`, `host/src/ipfs`. |
| `attestation-ts/` | The TypeScript platform modules that read attestation documents (the only TypeScript that parses them). |
| `e2e/` | End-to-end scenarios over real processes: the host, the enclave, a simulated chain and the real wallet and verifier code. See `e2e/README.md`. |
| `deploy/` | Dockerfiles and compose files. See `deploy/README.md`. |
| `vectors/`, `vectors-tools/` | Shared test vectors (Rust and TypeScript must agree on every byte) and the tools that generate them. |
| `scripts/` | Checks run in CI: AWS formats stay inside the attestation modules, card vectors in step with the verifier. |

The wallet side is `wallet-sdk/packages/wallet-sdk/src/notary/`, and the verifier side is
`membership_card_verifier/packages/verifier/src/notary/`.

## Run the whole stack locally

Everything here runs against **simulators**: a simulated enclave (fixed test keys), and a simulated chain, IPFS and EAS.
No AWS, no real chain and no real keys are involved.

You need: Rust (the pinned toolchain installs itself from `rust-toolchain.toml`), Node 22 or later, pnpm 9.6
(`corepack enable && corepack prepare pnpm@9.6.0 --activate`), and Docker for the Docker routes. Run every command from
the repository root unless it says otherwise.

### 1. Build the TypeScript the host and the scenarios use

Each package is its own pnpm workspace with its own lockfile; the installs are `--frozen-lockfile`:

```bash
REPO_ROOT=$PWD sh notary/deploy/build-ts-deps.sh          # verifier, app-sdk, attestation-ts, wallet-sdk (a few minutes)
(cd notary && pnpm install --frozen-lockfile --filter "./host..." --filter "./e2e..." && pnpm --filter ./host run build)
```

### 2. Build the enclave side

```bash
(cd notary && cargo build --locked -p notary-runtime -p notary-sim)
```

### 3. Run the scenarios

```bash
(cd notary && bash e2e/run-local.sh)
```

This starts the simulated chain, the fake enclave, `notary-runtime`, and the host, then runs four scenarios against them
and prints `... PASS` for each: an aggregation job (with a total loss and resubmission), a vote (one ballot replaced, a
below-`k_min` vote, a total loss, the wallet's rejections), derived cards with `sealed_link` revocation, and derived cards
with `expiry_only`. It takes about five minutes. `PHASES="setup vote" bash e2e/run-local.sh` runs only those phases.

Three hosts, with a replica killed in the middle of a vote, run in Docker (about eight minutes; it builds the images
from the lockfiles):

```bash
bash notary/e2e/run-three.sh
```

### 4. Run the tests

```bash
(cd notary && cargo test --workspace)                    # the Rust workspace
(cd notary/host && pnpm exec vitest run)                 # the host
(cd notary/e2e && pnpm exec vitest run)                  # derived cards through the verifier, and the template checks
(cd notary && bash scripts/check-aws-isolation.sh)       # no AWS attestation format outside the attestation modules
(cd notary && bash scripts/check-card-vectors.sh)        # Rust and TypeScript card checks agree
```

The integration stack (a local devnode with the real registry contracts, Kubo, EAS) runs the chain clients' tests; see
`integration_tests/suites/notary/README.md` and `integration_tests/run.sh --with-notary`.

## Things to know before changing anything

- **The enclave's image is its identity.** Anything compiled into `notary-runtime` changes its PCR0, and users trust a
  runtime by PCR0 (the governance list). Dependency changes to the runtime crates are security reviews.
- **The post-quantum crates and `wasmi` are pinned exactly** (`Cargo.toml` files); `deploy/` builds use `--locked` and
  lockfile installs. Dependency review notes: `plans/notary-dependency-audit.md`.
- **No AWS yet.** The enclave image (`deploy/eif/`) and anything on real AWS Nitro Enclaves hardware is Phase 8; the simulator stands in.
- **The test keys in `e2e/sim.env` are public.** Never use them anywhere else.
