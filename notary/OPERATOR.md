# Notary Operator Guide

For the people who run a notary host and its enclaves. Modeled on `press/OPERATOR.md`. The specs behind it:
`specs/object_specs/notary_host.md` (the host), `notary_runtime.md` (the enclave), `specs/process_specs/notary_lifecycle.md`
(genesis and jobs), `notary_replication_and_recovery.md` (replicas, upgrades, total loss) and
`derived_card_revocation_propagation.md`. To run the local stack first, see [README.md](README.md).

## What works today, and what does not

| | Status |
|---|---|
| The whole stack on **simulators** (simulated enclave, chain, IPFS and EAS) | Works. This is what the sections below let you run. |
| The host's **chain, EAS and Kubo clients** against a real registry on a local devnode | The clients' tests pass (`integration_tests/run.sh --with-notary`, which tests the clients directly). The host was started once in `CHAIN_PROVIDER=rpc` mode against the devnode and Kubo (a manual smoke run: healthy, enclave attested); no job has run through that stack, and `--with-notary` does not start the host in that mode. |
| The enclave on **AWS Nitro Enclaves** | **Not available.** The enclave image recipe (`deploy/eif/`), the real attestation backend and any AWS provisioning are Phase 8. Nothing in this guide has been run on real Nitro hardware. |
| Production chain, EAS schema and governance lists on Arbitrum One | **Not done.** The governance scripts here run against a local devnode only. |

Treat the production parts below (sizing, the AWS shape, monitoring) as the plan the specs describe, not as a tested
deployment.

## What you run, and what you can and cannot see

```
relay ──OHTTP──▶ host (nitropack app, outside the enclave) ──vsock proxy──▶ enclave (notary-runtime)
                  │  Redis (host state)                                  keys exist only in enclave memory
                  │  Kubo / IPFS, EAS, registry via the gas wallet
```

- **The host** accepts sealed inputs through the relay's oblivious gateway, stores the ciphertexts, signs receipts, pins
  records to IPFS, anchors job logs with EAS, submits the enclave-signed derived-card registrations, relays messages
  between replicas, and delivers private outputs. It **cannot** read an input, a key or a result.
- **The enclave** (`notary-runtime`) holds the notary's identity key, the job keys and the derived-card tag keys. Closing
  your host stalls a job; it cannot make the notary lie, because every object is re-checked inside the enclave and by
  every verifier.
- **You see** which wallets' ciphertexts arrive and when, and the registry's public data. You do not see which source
  card a derived card came from.

## Requirements

- A host machine with Docker (the simulator stack), or (production, Phase 8) an enclave-capable EC2 parent instance.
- Redis for the host's durable state (`EXTERNAL_KV_URL`). The `memory:` URL loses everything at restart and is refused
  unless the chain is simulated.
- A funded **gas wallet** on the chain: it pays for derived-card registrations and EAS anchors.
- A registered **operator card** (the card the policy holders see on your notary card, `operator_card`), and a relay
  `target_id` for the host (`NOTARY_RELAY_TARGET_ID`).
- For `CHAIN_PROVIDER=rpc`: an Arbitrum RPC endpoint that supports `debug_getRawHeader` (the chain feed needs block header
  RLP; a hosted endpoint without the debug API cannot feed the host), the registry's logic and storage contract
  addresses, the EAS contract and the notary schema UID (`governance/scripts/notary-eas.ts` registers the schema, devnode
  only for now), a Kubo node, and a wallet service to deliver private outputs through (`NOTARY_DELIVERY_URL`).

## Stand up the simulator stack

```bash
bash notary/e2e/run-compose.sh        # builds the images from the lockfiles, starts the stack, runs setup and the aggregation job
KEEP=1 bash notary/e2e/run-compose.sh # the same, and leaves the stack up to poke at
```

`deploy/docker-compose.sim.yml` starts the host, Redis, the simulated enclave and a simulated chain service. Every key
in `e2e/sim.env` is a public test value: **never reuse any of them.** The compose run covers setup and the aggregation job;
the vote, derived-card and `expiry_only` scenarios need the process runner (`bash notary/e2e/run-local.sh`, see the README).

## Configuration

All configuration is environment variables; the full table is `notary_host.md` §4. The host **validates all of them at
startup and reports every problem at once**, and refuses to start rather than fall back to in-memory services.

| Group | Variables |
|---|---|
| Keys | `NOTARY_HOST_MLDSA44_PRIVATE_KEY` (a 32-byte ML-DSA-44 seed, base64url; its public key must equal `operator_host_pubkey` on each notary card), `NOTARY_OHTTP_PRIVATE_KEY` (X25519, 32 bytes base64url), `NOTARY_GAS_WALLET_PRIVATE_KEY` (hex), `NOTARY_ADMIN_TOKEN` (at least 32 characters; guards `/genesis`, `/operator/*` and `/jobs/{hash}/restart`) |
| Chain (production) | `CHAIN_PROVIDER=rpc`, `ARBITRUM_RPC_URL`, `EXPECTED_CHAIN_ID` (the host refuses to start if the RPC reports another chain), `REGISTRY_CONTRACT_ADDRESS` (the logic contract), `REGISTRY_STORAGE_ADDRESS`, `EAS_CONTRACT_ADDRESS`, `NOTARY_EAS_SCHEMA_UID`, `NOTARY_DELIVERY_URL` |
| Storage | `IPFS_PROVIDER=kubo` with `KUBO_API_URL` (required with `rpc`), `EXTERNAL_KV_URL` (Redis) |
| Enclaves | `ENCLAVE_CIDS`, `ENCLAVE_ENDPOINTS` (how to reach each: the vsock proxy in production, a socket in the simulator) |
| Public face | `NOTARY_RELAY_TARGET_ID`, `NOTARY_PUBLIC_BASE_URL` |
| Other | `PEER_HOSTS` (other operators' hosts, for cross-operator replicas), `SNAPSHOT_REFRESH_SECONDS` (30), `REATTEST_INTERVAL_SECONDS` (21600; read but **not used yet**: the host does not re-attest on a schedule, so a job that runs longer than the wallets' attestation age limit, 24 hours by default, needs a restart or a handoff to be re-attested), `ALERT_WEBHOOK_URL`, `GAS_BALANCE_LOW_WEI` |

Keep the three keys and the admin token out of images and shell history. The host key and the OHTTP key are stable
identities: rotating the host key means every notary card's `operator_host_pubkey` no longer matches.

## First run: notary genesis

The sequence is `notary_lifecycle.md` Phase 0. A worked, runnable version is `genesisFor()` in
`notary/e2e/src/driver.ts`. In outline:

1. **You:** `POST /genesis` on your host (bearer `NOTARY_ADMIN_TOKEN`) with a genesis request naming the notary policy,
   your `operator_card`, your `operator_host_pubkey` and the platform. The enclave generates its identity key `K_id` and
   chain key `K_chain` (neither leaves it) and returns the completed request and a genesis attestation.
2. **You → the policy holder:** send both. The policy holder's wallet runs algorithm G (the attestation must be at most
   7 days old and the runtime's PCR0 must be on the governance list) and signs a notary card offer.
3. **You:** `POST /genesis/countersign` with the offer. The enclave countersigns with `K_id` and writes the first
   identity-log record.
4. **A press** for the notary-card policy registers the card. The policy holder adds it to `approved_notaries`. For a
   template policy (derived cards), governance also authorizes the notary's chain key as a press for that template, once
   per (template, operator): the registry then accepts the enclave's `RegisterCard` writes.

The host serves the card it created at once and remembers it in Redis; `NOTARY_CARD_ADDRESSES` is only for cards created
elsewhere. **A notary card belongs to one policy**: serving a second policy (for example a derive template as well as a
community's aggregation policy) needs a second genesis and a second card.

Derived-card templates also need a tag key: `POST /operator/template-seed` (bearer token) once per template, on the first
enclave serving it.

## Running jobs

| Route | Who calls it | What it does |
|---|---|---|
| `POST /jobs` | the requester | opens a job. With several replicas, only the host serving the first replica keys it; post the job to every host in `replica_set`. |
| `GET /jobs/{hash}/status` | anyone | state, epoch, live replica count, job-log head |
| `GET /health` | monitoring | `status` and the number of attested enclaves |
| `POST /jobs/{hash}/restart` | you | the job key is lost: starts the next epoch |
| `POST /operator/handoff`, `/operator/shutdown` | you | moves a key or a job between instances; stops one |

Wallets reach the announcement and input routes **only** through the relay gateway; a direct call is refused
(`NH_DIRECT_FORBIDDEN`).

### Programs the enclave will run

A `shared` job runs only programs on the governance **program allowlist**; the committed templates are
`aggregate`, `vote`, `vote-yna` and `derive` (`notary/templates`). The enclave admission-checks every program (imports,
floating point, limits, output schema) whatever the allowlist says.

## Sizing

Measured by the capacity benchmark (`plans/notary-code-plan.md` §11): Linux arm64 in Docker on Apple Silicon, one broker
thread, **not** AWS Graviton, and without the vsock round trip or the host. Treat these as order of magnitude.

| | Figure |
|---|---|
| Submit | about 290 to 315 inputs per second per broker thread (3.2 to 3.5 ms each), independent of world size and of how many jobs run at once |
| Close | about 2.3 ms per input, single-threaded and linear: a 1,000-input job closes in about 2.3 s, a 10,000-input job in about 24 s |
| Memory per open job | about 200 bytes per input (hashes and root keys; the **host** keeps the ciphertexts) |
| Memory at close | about 10 to 25 KB per input: roughly 100 to 250 MiB for a 10,000-input job; one close runs at a time per broker |
| Snapshots | about 5 KB per card under a snapshotted policy (an estimate; about 50 MiB for 10,000 cards) |

Not measured: the host's storage per input (sealed input up to 256 KiB, `NH_INPUT_TOO_LARGE`), real AWS Nitro Enclaves memory
limits, and any cost. No AWS resources exist yet, so there are no cost figures here; get them when the first instance is
provisioned.

## Monitoring

`GET /health` shows the number of attested enclaves; zero means the host cannot serve. Alerts (`ALERT_WEBHOOK_URL`) carry
only a level, a code and counts, never job data (`notary_host.md` §13). The host checks, every 30 seconds, and repeats an alert at
most every five minutes: `enclaves_attested` (fewer live enclave sessions than configured), `replicas_below_min_live` (a live job
with fewer live replicas than its `min_live`), `gas_balance_low` (the gas wallet below `GAS_BALANCE_LOW_WEI`, default 0.01 ETH, or
unreadable; production chain only) and `snapshot_lag` (no full snapshot pass for more than three refresh intervals). It also raises
`anchor_backlog`, `storage_failure`, `delivery_failed`, `close_failed`, `enclave_lost` and `need_replica_failed` where they happen (and forwards the enclave's `press_unreadable`),
and forwards its enclaves' alerts. With no gas the host cannot register derived cards or anchor job logs, and a job's enclave stops
signing a log it has no anchor receipt for.

## Upgrading the runtime when governance changes the accepted list

Governance retires a runtime as `superseded` (normally 30 days' notice; at least 72 hours if expedited) or `vulnerable`
(immediate). What you do (`notary_replication_and_recovery.md` §3):

| New runtime | What you do |
|---|---|
| Same `close_compat` | Start enclaves on the new image and hand identity and template keys, and running jobs, to them one replica at a time (`POST /operator/handoff`); live replicas never fall below `min_live`. Wallets see a re-issued announcement. Stop an old enclave only when it holds no job that needs it and every key it held was handed on. |
| Different `close_compat` | The same handoff for keys. Aggregate jobs that close before the old runtime's `retired_at` finish on the old image; longer ones move by a `runtime_migration` epoch, which costs offline contributors their inputs. |
| `vulnerable` | **Keys are never handed on.** The notary card is dead: redo genesis on a new image, and policy holders reissue. Jobs move by a `key_exposure` epoch. |

Stopping an old enclave destroys its keys (they exist only in enclave memory), so hand off before you stop.

## When something goes wrong

- **A replica is lost.** The leader writes `replica_lost` after the 120 s liveness window and a standby is handed the job.
  The standby must already be running: the host's `need_replica` handler is an in-memory recorder, so **nothing starts a
  replacement enclave for you yet** (`run-three.sh` works because host C's second enclave was started in advance). Keep a
  standby, check the job's live replica count against `min_live`, and start a replacement yourself.
- **Every replica is lost.** No enclave holds the job key. Call `POST /jobs/{hash}/restart` (`{"reason": "total_loss"}`):
  the next epoch starts, wallets see the new announcement and resubmit their stored inputs. Offline contributors lose
  theirs. The notarization records the epoch reason (`EPOCH_TOTAL_LOSS`).
- **A long outage and derived cards.** A derived-card release is judged on the enclave's attested clock at the batch
  boundary the clock is in. A card offered for one boundary becomes stale if the clock is more than one issuance interval
  past it, and the holder is **re-offered**, not issued, so an outage across a boundary means holders are asked again.
  Nothing is lost; do not expect the original boundary to hold.
- **`sealed_link` revocation does nothing.** The enclave reads a source card's update only if the entry is **canonical
  JSON (RFC 8785)** and signed by a press the source policy lists in `approved_presses` **by the CID of the press card's
  published document**. An entry that is not canonical is ignored. A listed press pointer whose card cannot be read
  (for example a sealed genesis) is **skipped**, so that press certifies nothing, and the enclave raises a `press_unreadable`
  alert (once per change in the count, not repeated). The other listed presses still count. Tell the source policy's issuer
  to list that press by the CID of its published document. `notary-lint` warns about this beforehand (`LINT_PRESS_POINTER`) for any pointer in the policy's `approved_presses`.
- **The host will not start.** It prints every configuration problem at once. Common ones: `memory:` storage with a
  production chain, `CHAIN_PROVIDER=rpc` without `IPFS_PROVIDER=kubo`, a missing `REGISTRY_STORAGE_ADDRESS` or
  `NOTARY_DELIVERY_URL`.
- **Error codes** returned by the host (`notary_host.md` §14): `NH_DIRECT_FORBIDDEN`, `NH_JOB_UNKNOWN`, `NH_JOB_CLOSED`,
  `NH_ENCLAVE_UNAVAILABLE` (no local enclave holds the job; retry), `NH_INPUT_TOO_LARGE`, `NH_STORAGE_FAILED` (no receipt
  is issued), `NH_UNAUTHORIZED`.

## Keeping dependencies safe

Images build from lockfiles (`pnpm install --frozen-lockfile`, `cargo build --locked`) on base images pinned by digest.
Dependabot opens pull requests for updates; the post-quantum crates and `wasmi` are pinned exactly and bumped
deliberately, because a change there changes the runtime's PCR0. Background: `plans/notary-dependency-audit.md`.
