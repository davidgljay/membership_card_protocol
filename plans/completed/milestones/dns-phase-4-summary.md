# DNS Phase 4 Milestone Summary

**Date:** 2026-06-27  
**Status:** Step 4.1 complete — Step 4.2 pending David's Sepolia deployment  
**Implementation plan:** [dns-implementation-plan.md](../dns-implementation-plan.md)

---

## Step 4.1 — Deployment Scripts Updated

### Files created / updated

| File | Action |
|---|---|
| `contracts/scripts/deploy.sh` | Updated NEXT STEPS to include DNS bootstrap and test instructions |
| `contracts/scripts/build_governance_payload.rs` | Added DNS operations: `register_domain`, `deregister_domain`, `set_dns_governance_policy_address`, `clear_domain_entries`, `flag_domain_fraud_risk`, `governance_set_policy_address` |
| `contracts/scripts/setup_dns.sh` | **New** — DNS governance bootstrap script (RegisterPolicy, AuthorizePress, SetDnsGovernancePolicyAddress) |
| `contracts/scripts/test_dns.sh` | **New** — End-to-end DNS test script (Steps 4.2.1–4.2.4) |
| `contracts/tests/src/SepoliaIntegration.t.sol` | Updated with Phase 4 address placeholders, legacy contract checks, and DnsGovernanceBody keyset verification |
| `contracts/deployments/README.md` | Added Phase 4 migration note, DNS bootstrap sequence, superseded deployment table |

### Migration note

The storage contract must be redeployed for Phase 4. New DNS storage tables (`DomainRegistrations`, `PolicyAddresses`, `DnsAdminCardKeys`, `DnsGovernancePolicyAddress`) require new contract bytecode. The prior Sepolia storage (`0xe497b4ba...`) is superseded. The verifier module (`0xdf4c2078...`) is NOT redeployed.

### `build_governance_payload.rs` additions

New operations added (all lexicographic JSON field order per RFC 8785):

| `--op` argument | Operation | Fields |
|---|---|---|
| `register_domain` | §4.17 RegisterDomain | `admin_card_address`, `admin_secp256r1_key`, `domain` |
| `deregister_domain` | §4.18 DeregisterDomain | `domain` |
| `set_dns_governance_policy_address` | §4.24 SetDnsGovernancePolicyAddress | `new_policy_address` |
| `clear_domain_entries` | §4.21 ClearDomainEntries | `domain`, `paths` |
| `flag_domain_fraud_risk` | §4.22 FlagDomainFraudRisk | `domain`, `fraud_risk`, `suspension_expires_at` |
| `governance_set_policy_address` | §4.23 GovernanceSetPolicyAddress | `domain`, `path`, `policy_card_address` |

All operations include: `governance_version`, `nonce`, `op`, `timestamp`.

### Forge tests

149 unit tests pass across all 9 suites (DnsOps, GovernanceOps, CardOps, SubCardOps,
Integration, StorageInvariants, UpgradeOps, Verifier, smoke). Zero failures. The SepoliaIntegration
tests are excluded from the unit test run and require a live fork.

---

## Step 4.2 — Sepolia Deployment (Pending)

**Responsible:** David (testnet wallet/key required)

### Deployment procedure

```bash
source contracts/.env
export PRIVATE_KEY=0x...            # Ethereum gas wallet
export DEPLOYER_SECP256R1_PUBKEY=... # 64-byte secp256r1 pubkey (already in .env)
export SECP256R1_PRIVKEY=...         # secp256r1 private key (already in .env)

# 1. Deploy all three contracts
./contracts/scripts/deploy.sh sepolia
# → Records addresses in contracts/deployments/sepolia.json

# 2. Bootstrap DNS governance
export LOGIC_ADDRESS=<from sepolia.json>
./contracts/scripts/setup_dns.sh
# → RegisterPolicy, AuthorizePress, SetDnsGovernancePolicyAddress
# → Prompts before each transaction

# 3. End-to-end DNS test
./contracts/scripts/test_dns.sh
# → RegisterCard, RegisterDomain, SetPolicyAddress, LookupPolicyAddress,
#    RemovePolicyAddress, LookupPolicyAddress (zero)

# 4. Update SepoliaIntegration.t.sol with new addresses, then run Sepolia fork tests
cd contracts/tests
./contracts/scripts/run_sepolia_tests.sh -v
```

### Step 4.2 acceptance criteria

- [ ] `deploy.sh sepolia` completes successfully; `deployments/sepolia.json` updated
- [ ] `setup_dns.sh` completes: DNS policy registered, DNS press active, DnsGovernancePolicyAddress set
- [ ] `test_dns.sh` passes all 6 checks:
  - [ ] RegisterCard (admin card + policy card under DNS governance policy)
  - [ ] RegisterDomain for `test.example.com`
  - [ ] SetPolicyAddress for `test.example.com/staff/reporter`
  - [ ] LookupPolicyAddress returns the correct policy card address
  - [ ] RemovePolicyAddress via governance quorum
  - [ ] LookupPolicyAddress returns `bytes32(0)` after removal
- [ ] SepoliaIntegration.t.sol updated with new contract addresses
- [ ] Sepolia fork tests pass (`run_sepolia_tests.sh`)

---

## CP-3 (Mainnet) — Not Yet Reached

Step 4.3 (mainnet migration plan) and Step 4.4 (mainnet deployment) require David's explicit
approval per the CP-3 hard stop in the implementation plan. The testnet deployment (Step 4.2)
must be verified first.
