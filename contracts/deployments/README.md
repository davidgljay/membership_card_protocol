# Card Protocol Registry — Deployment Procedure

## Architecture

Three contracts are deployed. Their addresses are fixed at deployment time. Only
the logic contract and verifier module can be upgraded; the storage contract
address is the stable on-chain identifier for the protocol.

```
verifier-module      (upgradeable, 48-hour timelock)
     │
     │ staticcall (verify_secp256r1)
     │
logic-contract  ────▶  storage-contract
(upgradeable,           (immutable address,
 7-day timelock)         all persistent state)
```

## Address Dependency Problem

There is a circular dependency at deployment time:

- `storage-contract` must know `logic-contract`'s address (to enforce `onlyLogic`).
- `logic-contract` must know `storage-contract`'s address (to call state setters).

### Resolution: Initialize Pattern

All three contracts are deployed with unset pointers, then wired via explicit
`initialize()` calls:

1. Deploy `verifier-module` → get `VERIFIER_ADDRESS`.
2. Deploy `storage-contract` → get `STORAGE_ADDRESS`.
3. Deploy `logic-contract` → get `LOGIC_ADDRESS`.
4. Call `storage.initialize(LOGIC_ADDRESS, DEPLOYER_PUBKEY)`:
   - Sets `logic_contract = LOGIC_ADDRESS`.
   - Creates bootstrap 1-of-1 governance keysets (RootPolicyBody and PressRegistryBody)
     with `DEPLOYER_PUBKEY` as the sole governance key.
   - Reverts if called again (one-time initialization).
5. Call `logic.initialize(STORAGE_ADDRESS, VERIFIER_ADDRESS)`:
   - Sets storage and verifier pointers in the logic contract.
   - Reverts if called again.

**Security note**: Steps 4 and 5 must be called in the same transaction bundle
(or at minimum in rapid succession with the same EOA) to prevent front-running
of the initialize calls on a live network. On Arbitrum, the sequencer ordering
provides some protection, but using a deployment script that sends both
transactions atomically (or using a deployer contract) is strongly preferred.

## Prerequisites

```bash
# Install Rust + wasm target
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32-unknown-unknown

# Install cargo-stylus
cargo install cargo-stylus

# Install Foundry
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

## Environment Variables

```bash
export ARBITRUM_SEPOLIA_RPC=https://sepolia-rollup.arbitrum.io/rpc
export ARBITRUM_MAINNET_RPC=https://arb1.arbitrum.io/rpc

# For deployment: use a hardware wallet or set PRIVATE_KEY (testnet only)
export PRIVATE_KEY=0x...

# The secp256r1 public key (x||y, 64 bytes hex) for bootstrap governance.
# Generate with: cargo run --bin gen_test_vectors (uses p256 crate).
# For mainnet: export from a hardware wallet that supports P-256.
export DEPLOYER_SECP256R1_PUBKEY=0x...
```

## Running the Deployment

```bash
# Testnet (Arbitrum Sepolia)
chmod +x contracts/scripts/deploy.sh
./contracts/scripts/deploy.sh sepolia

# Mainnet (requires manual confirmation)
./contracts/scripts/deploy.sh mainnet
```

Deployed addresses are saved to `deployments/<network>.json`.

## Running Tests

```bash
# Unit tests (mock contracts, no RPC needed)
cd contracts/tests
forge test -vvv

# Fork tests (require live RPC for RIP-7212 precompile)
forge test -vvv --fork-url $ARBITRUM_SEPOLIA_RPC

# Specific test file
forge test --match-contract CardOpsTest -vvv

# Gas report
forge test --gas-report
```

## Generating Test Vectors

```bash
cd contracts
cargo run --manifest-path scripts/Cargo.toml --bin gen_test_vectors
# Writes scripts/test_vectors.json
```

## Phase 4 Migration Note (DNS Resolution)

Phase 4 adds DNS resolution tables to the storage contract:
`DomainRegistrations`, `PolicyAddresses`, `DnsAdminCardKeys`, `DnsGovernancePolicyAddress`.

**The storage contract must be redeployed** — new storage mappings require new contract bytecode;
Stylus contracts cannot add storage slots via logic upgrades. The storage contract address changes,
which is a protocol migration. The prior Sepolia deployment (testnet) is superseded; any state from
the prior deployment is abandoned. Mainnet has not yet been deployed, so no migration is needed there.

The `DnsGovernanceBody` (body_id=2) governance keyset is bootstrapped alongside `RootPolicyBody`
and `PressRegistryBody` in `storage.initialize()`. No separate initialization call is needed for
the DNS governance body itself.

## Post-Deployment Bootstrap Sequence

After `initialize()` calls, the protocol is in a 1-of-1 governance state with the
deployer's secp256r1 key controlling all three governance bodies. This is a temporary
state and must be transitioned as soon as possible.

**Recommended bootstrap order:**

1. **RegisterPolicy** (RootPolicyBody quorum): Register the organization's main policy.
2. **AuthorizePress** (PressRegistryBody quorum): Authorize the first press under that policy.
3. **DNS bootstrap** — run `./contracts/scripts/setup_dns.sh`:
   - **RegisterPolicy** (RootPolicyBody quorum): Register the DNS governance policy.
   - **AuthorizePress** (PressRegistryBody quorum): Authorize a press under the DNS policy.
   - **SetDnsGovernancePolicyAddress** (DnsGovernanceBody quorum): Wire the DNS policy into storage.
4. **RotateGovernanceKeys** (RootPolicyBody): Expand from 1-of-1 to multi-sig
   (minimum 3 keys, majority quorum). This is the most critical step — the 1-of-1
   bootstrap key is a single point of failure.
5. **RotateGovernanceKeys** (PressRegistryBody): Expand press registry governance.
6. **RotateGovernanceKeys** (DnsGovernanceBody): Add board member keys; add dedicated script key.
7. Confirm the bootstrap key is safely stored or destroyed.

**DNS end-to-end verification** — after step 3, run `./contracts/scripts/test_dns.sh` to verify
RegisterDomain → SetPolicyAddress → LookupPolicyAddress → RemovePolicyAddress.

## Deployed Addresses

### Arbitrum Sepolia (Testnet) — Phase 4 (DNS)

_Update after running `./contracts/scripts/deploy.sh sepolia` for Phase 4._
_See `deployments/sepolia.json` for the current deployment record._

```json
{
  "network": "arbitrum_sepolia",
  "contracts": {
    "verifier_module": "0xdf4c20783a1c88f47363adbcf654a12f35d77d3e",
    "storage_contract": "0x... (Phase 4 — update after deployment)",
    "logic_contract":   "0x... (Phase 4 — update after deployment)"
  }
}
```

**Superseded Sepolia deployments (pre-Phase-4):**

| Deployment | Storage | Logic | Notes |
|---|---|---|---|
| 2026-06-23 | `0xe497b4ba...` | `0xa1711fc1...` | DNS tables not included; superseded |
| 2026-06-22 | `0x9272a512...` | `0xd73116bd...` | ABI selector fix; pre-DNS |
| 2026-06-22 | `0x9272a512...` | `0xc6bf998e...` | Original broken sol_interface! selectors |

The verifier module (`0xdf4c2078...`) is NOT redeployed — it has no state and does
not need new DNS-specific logic.

### Arbitrum One (Mainnet)

_Not yet deployed._

## Upgrade Procedure

### Logic Upgrade (7-day timelock)

1. Deploy new logic contract: `cargo stylus deploy -p logic-contract`
2. Call `logic.propose_logic_upgrade(new_address, payload_hash, nonce, gov_version, sigs)`
3. Wait 7 days (604,800 seconds).
4. Call `logic.confirm_logic_upgrade(new_address, payload_hash, nonce, gov_version, sigs)`
   - Uses FRESH governance signatures (not the proposal signatures).
   - Signatures must be from the SAME governance keyset version as proposal.
5. Old logic contract is now locked out of storage.
6. Update `deployments/<network>.json` with new logic address.

To cancel: `logic.cancel_logic_upgrade(payload_hash, nonce, gov_version, sigs)`

### Verifier Upgrade (48-hour timelock)

Same flow as logic upgrade, but using `propose_verifier_upgrade` /
`confirm_verifier_upgrade` / `cancel_verifier_upgrade`. Timelock is 48 hours
(172,800 seconds) instead of 7 days.

## Security Contacts

For security issues with the smart contracts, contact: [to be filled in]

For audit reports: see `audits/` directory (to be populated after audit).
