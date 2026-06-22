# Card Protocol Registry Contracts

Rust/Stylus (WASM) implementation of the Card Protocol on-chain registry for Arbitrum One.

**Spec:** `specs/object_specs/registry_contract.md` v0.3  
**Implementation plan:** `plans/contract-implementation-plan.md`  
**Status:** Phases 1–8 complete (scaffolding → integration tests). Phases 9–11 (Sepolia deployment, audit, mainnet) pending.

---

## Contract Architecture

Three separate contracts with distinct roles (§6.3 of spec):

```
verifier-module      (upgradeable, 48-hour timelock via UpgradeVerifier)
     │
     │ staticcall — verify_secp256r1 via RIP-7212 precompile at 0x...0100
     │
logic-contract  ──────────────────▶  storage-contract
(upgradeable,                         (IMMUTABLE ADDRESS — permanent
 7-day timelock via UpgradeLogic)      protocol identifier, all state)
```

| Contract | Crate | Role |
|---|---|---|
| `storage-contract` | `storage-contract/` | All persistent state; enforces unconditional invariants; no business logic |
| `logic-contract` | `logic-contract/` | All write operations, authorization checks, event emission |
| `verifier-module` | `verifier-module/` | secp256r1 verification via RIP-7212 precompile (Phase 1) |
| _(shared)_ | `protocol-types/` | Types, error codes, payload parsing — used by all three |

---

## Directory Structure

```
contracts/
  Cargo.toml                      Workspace manifest
  protocol-types/src/lib.rs       Shared structs, error codes, payload parser
  storage-contract/src/lib.rs     Storage contract (~921 lines)
  logic-contract/src/
    lib.rs                        Contract entrypoint, cross-contract interfaces
    write_gate.rs                 §6.1 card write gate + §6.2 governance quorum
    card_ops.rs                   §4.1 RegisterCard, §4.2 UpdateCardHead, §4.5 ClaimOpenOffer,
                                  §4.13 RegisterAddressForward, §4.15 BatchUpdateCardHeads
    subcard_ops.rs                §4.3 RegisterSubCard, §4.4 DeregisterSubCard
    governance_ops.rs             §4.6–4.10 policy, press, key rotation operations
    upgrade_ops.rs                §4.14 logic upgrade, verifier upgrade (7-day / 48-hour timelocks)
    key_scheme_ops.rs             §4.11 RotateOnChainKeyScheme (Phase 1: always E-24)
  verifier-module/src/lib.rs      RIP-7212 precompile wrapper
  tests/
    foundry.toml                  Fork profiles (arbitrum_sepolia, arbitrum_mainnet)
    src/
      smoke.t.sol                 RIP-7212 precompile reachability check
      StorageInvariants.t.sol     §3.7 unconditional invariant tests
      Verifier.t.sol              secp256r1 test vectors, gas measurement
      CardOps.t.sol               §4.1, 4.2, 4.5, 4.13, 4.15 acceptance criteria
      SubCardOps.t.sol            §4.3, 4.4 acceptance criteria
      GovernanceOps.t.sol         §4.6–4.10 acceptance criteria
      UpgradeOps.t.sol            §4.14 timelock tests
      Integration.t.sol           Phase 8 end-to-end scenarios
      mocks/
        MockStorage.sol           Solidity mock matching storage contract ABI
        MockLogic.sol             Solidity mock matching logic contract ABI
        MockVerifier.sol          Mock verifier (always-true and always-false variants)
  scripts/
    deploy.sh                     Deployment script (sepolia / mainnet)
    gen_test_vectors.rs           secp256r1 test vector generator (p256 crate)
  deployments/
    README.md                     Full deployment procedure, upgrade procedure
```

---

## Prerequisites

```bash
# Rust with WASM target
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32-unknown-unknown

# cargo-stylus (Stylus deployment + check tool)
cargo install cargo-stylus

# Foundry
curl -L https://foundry.paradigm.xyz | bash && foundryup
```

---

## Building

```bash
cd contracts

# Check all crates compile to WASM
cargo check --target wasm32-unknown-unknown

# Build release WASM (required before deployment)
cargo build --target wasm32-unknown-unknown --release

# Validate Stylus contracts (checks size, host-call validity)
cargo stylus check -p storage-contract
cargo stylus check -p logic-contract
cargo stylus check -p verifier-module
```

---

## Running Tests

```bash
cd contracts/tests

# First-time setup: install forge-std (gitignored, not committed)
forge install foundry-rs/forge-std --no-git

# Unit + mock tests (no RPC required)
forge test -vvv

# Fork tests (require RIP-7212 precompile — needs live Arbitrum node)
export ARBITRUM_SEPOLIA_RPC=https://sepolia-rollup.arbitrum.io/rpc
forge test -vvv --fork-url $ARBITRUM_SEPOLIA_RPC

# Gas report
forge test --gas-report

# Specific test contract
forge test --match-contract CardOpsTest -vvv
forge test --match-contract IntegrationTest -vvv
```

**Testing approach:** Because Stylus WASM contracts cannot be deployed directly
in Foundry without a live Arbitrum node, unit tests use Solidity mock contracts
(`tests/src/mocks/`) that mirror the storage and logic ABI. The mocks are
complete implementations, not stubs — they enforce the same preconditions and
state transitions as the Rust contracts. Fork integration tests (marked
`@dev Requires ARBITRUM_SEPOLIA_RPC`) test against deployed Stylus contracts on
Arbitrum Sepolia.

---

## Deployment

See `deployments/README.md` for the full procedure including the initialize()
pattern for resolving the circular address dependency, bootstrap sequence,
and upgrade procedures.

```bash
# Testnet
./scripts/deploy.sh sepolia

# Mainnet (requires confirmation prompt)
./scripts/deploy.sh mainnet
```

---

## Key Design Decisions

- **Why three contracts?** The storage contract's address is the permanent protocol
  identifier. Separating storage from logic means the logic can be upgraded without
  changing the address that presses write to and verifiers read from.

- **Why Rust/Stylus?** The upgrade path to ML-DSA-44 on-chain verification (Phase 3)
  requires implementing a post-quantum signature algorithm. Stylus WASM can implement
  arbitrary cryptographic primitives; Solidity cannot.

- **Unconditional invariants (§3.7):** Five invariants enforced by the storage
  contract regardless of which logic contract is active: existence is write-once,
  forwards are immutable once set, revocation/deregistration timestamps are
  write-once-non-zero. A malicious logic upgrade cannot erase these.

- **secp256r1 + RIP-7212 (Phase 1):** On-chain write authorization uses secp256r1
  via the RIP-7212 precompile at `0x...0100`. ML-DSA-44 is retained for IPFS
  content signing (off-chain). ADR-012.

---

## Open Items Before Phase 9 (Sepolia Deployment)

- [ ] Resolve §4.13 authorization check: which press's key signs `RegisterAddressForward`?
  The spec says "the press that last wrote to `old_address`" — confirm this is the
  correct `PressAuthorizations` entry to look up.
- [ ] Decide on `min()` import for `RotateGovernanceKeys` key count check — use `core::cmp::min`.
- [ ] Run `cargo check --target wasm32-unknown-unknown` locally and resolve any
  remaining type errors. The sub-agent fixed all known errors but local compilation
  is required to confirm clean build.
- [ ] If any contract exceeds the 24 KB WASM size limit after `cargo stylus check`,
  split the logic contract using the delegatecall pattern.
- [ ] Generate real secp256r1 test vectors via `cargo run --bin gen_test_vectors`
  and replace the placeholder hex values in `Verifier.t.sol`.
