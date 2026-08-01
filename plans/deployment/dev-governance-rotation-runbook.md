# Dev governance rotation runbook

Resolves the "governance-authority blocker" from
[`phase-3-summary.md`](./phase-3-summary.md): `dev-tests` needs credentials
for **Body 0 (RootPolicyBody)** and **Body 2 (DnsGovernanceBody)** narrower
than the shared bootstrap key, so `extended/dns_governance_verifier.spec.ts`,
`extended/log_auditing.spec.ts`, and `extended/policy_creation.spec.ts` can
run without needing the Sepolia deployment's original governance authority
on every test run.

**Scope confirmed safe**: Sepolia and any future Arbitrum One (mainnet)
deployment are separate contract instances with independently-initialized
storage — no shared state, bytecode constants, or keys between them. This
only touches the dev/Sepolia deployment
(`contracts/deployments/sepolia.json`). Production hasn't been deployed yet
at all (`contracts/deployments/README.md`: "Not yet deployed").

**Current on-chain state** (confirmed via a live read on 2026-07-30): Bodies
0, 1, and 2 are all still 1-of-1 on the original deployer's secp256r1 key,
governance version 0 for each. No governance bootstrap (RegisterPolicy/
AuthorizePress/DNS ops) has run yet either — this is a clean starting point.

## Why this needs you, not an agent

1. **Key generation**: the new keypairs are real secret material that will
   hold on-chain authority. Generating them (or handling the private key
   values at all) is exactly the kind of action Claude should not perform —
   run `gen-dev-governance-keys.mjs` yourself, in your own terminal.
2. **Signing the rotation**: rotation is self-amending — the transaction
   must be signed by the body's **current** keyset (today, the original
   Sepolia deployer's secp256r1 key), not the new one. Only whoever holds
   that key can authorize this.
3. **This is a real, irreversible on-chain action.** Once a body is rotated,
   its previous keyset can no longer authorize anything for that body.

## Steps

### 1. Generate 6 new keypairs (3 for Body 0, 3 for Body 2)

Node resolves `node_modules` relative to the script file's own location, not
your working directory — `cd`-ing elsewhere and pointing at the script by a
relative path won't find `@noble/curves`. Copy it next to a `node_modules`
that already has that package (app-sdk's), run it there, then remove the
copy — run this from the repo root:

```bash
cp contracts/scripts/gen-dev-governance-keys.mjs app-sdk/packages/app-sdk/
cd app-sdk/packages/app-sdk
node gen-dev-governance-keys.mjs
cd -
rm app-sdk/packages/app-sdk/gen-dev-governance-keys.mjs
```

Save the 6 private keys somewhere secure (password manager, not a committed
file, not pasted back into any agent session). Keep the public keys handy —
those are safe to share and go into the next step.

### 2. Rotate Body 2 (DnsGovernanceBody) — the narrower, lower-risk one first

```bash
source contracts/.env   # or export the vars below directly
export LOGIC_ADDRESS=0x22206625803bcb584268b57dd6bd78cf61181399   # from deployments/sepolia.json
export PRIVATE_KEY=...                    # an Ethereum wallet to pay gas
export ARBITRUM_SEPOLIA_RPC=https://sepolia-rollup.arbitrum.io/rpc
export CURRENT_GOV_SECP256R1_PRIVKEY=...  # the ORIGINAL Sepolia deployer's secp256r1 key

./contracts/scripts/rotate_governance_body.sh 2 2 \
  <body2-key-1-pubkey> <body2-key-2-pubkey> <body2-key-3-pubkey>
```

The script reads the current version itself, builds and signs the payload,
prints it for review, and asks `Submit RotateGovernanceKeys transaction for
body 2? (y/N)` before sending anything on-chain.

### 3. Rotate Body 0 (RootPolicyBody)

Same command, body id 0, using Body 0's 3 new public keys:

```bash
./contracts/scripts/rotate_governance_body.sh 0 2 \
  <body0-key-1-pubkey> <body0-key-2-pubkey> <body0-key-3-pubkey>
```

**Note the scope tradeoff here** (per the earlier discussion): this hands
dev-tests standing authority to register new policies on the Sepolia
deployment going forward — broader than Body 2's DNS-only scope, but still
fully isolated from any future production deployment (see "Scope confirmed
safe" above).

### 4. Record the new keys in `dev-tests/.env`

```bash
# Body 2 (DNS governance) — 2-of-3 quorum, dev-tests holds all 3
DEV_TESTS_DNS_GOV_PRIVKEY_1=0x...
DEV_TESTS_DNS_GOV_PRIVKEY_2=0x...
DEV_TESTS_DNS_GOV_PRIVKEY_3=0x...

# Body 0 (root policy) — 2-of-3 quorum, dev-tests holds all 3
DEV_TESTS_POLICY_GOV_PRIVKEY_1=0x...
DEV_TESTS_POLICY_GOV_PRIVKEY_2=0x...
DEV_TESTS_POLICY_GOV_PRIVKEY_3=0x...
```

See `dev-tests/.env.example` for the full variable list and
`dev-tests/support/governance.ts` for how these get assembled into quorum
signatures at test time.

### 5. Verify

```bash
cd dev-tests
./run.sh --suite extended/dns_governance_verifier
./run.sh --suite extended/policy_creation
./run.sh --suite extended/log_auditing
```
