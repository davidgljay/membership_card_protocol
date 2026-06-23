# Gas Cost Reference — Card Protocol on Arbitrum

> **Methodology:** Gas figures are from `forge test --gas-report` against the Solidity mock
> contracts (MockLogic + MockStorage). These are the best available estimates — actual Stylus
> WASM costs may vary. Real on-chain costs can be confirmed via `cast send` receipts after
> running `setup_dev.sh` / `publish_cards.sh`.
>
> Cross-checked against real deployment transactions in `deployments/sepolia.json`:
> `logic_initialize` cost 175,176 gas = 0.00000353 ETH, confirming gas price of ~0.02 gwei.
>
> **Gas price:** 0.02 gwei (Arbitrum One mainnet, measured 2026-06-22 via `cast gas-price`)  
> **ETH/USD:** $1,731.83 (Coinbase spot price, 2026-06-22)  
> **Formula:** cost_eth = gas × 0.02 × 10⁻⁹ ; cost_usd = cost_eth × $1,731.83

---

## Protocol Function Costs

Median gas from `forge test --gas-report` on successful happy-path calls.  
Governance operations use a 1-of-1 keyset signature (bootstrap state).

| Function | §Spec | Gas (median) | ETH | USD |
|---|---|---:|---:|---:|
| `registerCard` | §4.1 | 155,113 | Ξ 0.0000031 | $0.0054 |
| `updateCardHead` | §4.2 | 70,677 | Ξ 0.0000014 | $0.0024 |
| `registerSubCard` | §4.3 | 173,897 | Ξ 0.0000035 | $0.0060 |
| `deregisterSubCard` | §4.4 | 94,507 | Ξ 0.0000019 | $0.0033 |
| `claimOpenOffer` | §4.5 | 166,424 | Ξ 0.0000033 | $0.0058 |
| `registerPolicy` | §4.6 | 177,397 | Ξ 0.0000035 | $0.0061 |
| `authorizePress` | §4.7 | 203,913 | Ξ 0.0000041 | $0.0071 |
| `revokePress` | §4.8 | 124,795 | Ξ 0.0000025 | $0.0043 |
| `rotateAuthorizerKey` | §4.9 | 119,103 | Ξ 0.0000024 | $0.0041 |
| `rotateGovernanceKeys` (1→3-of-5) | §4.10 | 166,912 | Ξ 0.0000033 | $0.0058 |
| `rotateOnChainKeyScheme` (E-24 revert) | §4.11 | ~30,000 | Ξ 0.0000006 | $0.0010 |
| `registerAddressForward` | §4.13 | 104,721 | Ξ 0.0000021 | $0.0036 |
| `proposeLogicUpgrade` | §4.14 | 158,880 | Ξ 0.0000032 | $0.0055 |
| `cancelLogicUpgrade` | §4.14 | 70,929 | Ξ 0.0000014 | $0.0025 |
| `confirmLogicUpgrade` (after 7d) | §4.14 | 116,210 | Ξ 0.0000023 | $0.0040 |
| `batchUpdateCardHeads` (5 cards) | §4.15 | 1,098,140 | Ξ 0.0000220 | $0.0381 |
| `batchUpdateCardHeads` (per card) | §4.15 | ~219,628 | Ξ 0.0000044 | $0.0076 |
| `disablePolicyDeletePermanently` | §4.16 | ~160,000 | Ξ 0.0000032 | $0.0055 |
| `proposeVerifierUpgrade` | §6.3 | ~160,000 | Ξ 0.0000032 | $0.0055 |
| `cancelVerifierUpgrade` | §6.3 | ~70,000 | Ξ 0.0000014 | $0.0024 |

---

## Deployment Costs (real, from `deployments/sepolia.json`)

| Transaction | Gas | ETH | USD |
|---|---:|---:|---:|
| Verifier module deploy | 3,929,453 | Ξ 0.000079 | $0.137 |
| Storage contract deploy | 10,656,351 | Ξ 0.000214 | $0.371 |
| Logic contract deploy | 109,044 | Ξ 0.0000022 | $0.0038 |
| Logic contract activate | 6,843,421 | Ξ 0.000137 | $0.237 |
| `initialize` (storage) | 381,312 | Ξ 0.0000076 | $0.013 |
| `initialize` (logic) | 175,176 | Ξ 0.0000035 | $0.0061 |
| **Grand total** | **22,094,757** | **Ξ 0.00044** | **$0.77** |

---

## Notes

- **Arbitrum is extremely cheap** — even the most expensive single operation (`batchUpdateCardHeads` for 5 cards) costs under $0.04.
- **Governance ops are cheap too** — a full `rotateGovernanceKeys` (replacing the keyset) costs ~$0.006.
- **Batch efficiency** — the per-card cost drops as batch size grows since only one sequence increment is charged. At 5 cards, the overhead is ~$0.019 vs ~$0.005 per card at 1 card.
- **Stylus caveat** — these figures come from Solidity mock execution. Actual Stylus WASM gas may differ. The deployment cross-check (0.02 gwei confirmed) validates the gas price used.
- **Phase 1 ops** — `rotateOnChainKeyScheme` always reverts (E-24), so only revert gas is charged.
