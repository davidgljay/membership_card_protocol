# Card Protocol — Notary Host Spec

**Version:** 0.1 (draft)  
**Date:** 2026-11-11  
**Status:** Draft. Implemented (`notary/host`, 2026-11) and run against the simulator and, for the chain, EAS and IPFS clients, a local devnode; not run on real hardware. Known gaps, in `OPERATOR.md`: no replica starter (§11 `need_replica`), no scheduled re-attestation (§11).  
**Architecture:** `ARCHITECTURE.md` ADR-013 · **Runtime:** `object_specs/notary_runtime.md` · **Processes:** `process_specs/notary_lifecycle.md`, `notary_replication_and_recovery.md`, `derived_card_revocation_propagation.md`
**Amended 2026-11-12:** §8 snapshot entries carry head-event history and `sub_card_doc_cid`; per-card fetch shapes defined; policy, requester and list-card reads use per-card fetches. Source: `plans/notary-spec-wording-e31.md`, approved by David 2026-11-12.

**Amended 2026-11-19 (6.5), for David's review** (`plans/notary-questions-6.5.md` E8): §8 a `sealed_link` job's source policies are snapshotted and updated until `ends_at` + 2 × `nullifier_period`; §10 `chain_submit` op `batch_update_card_heads` is submitted with its `calldata` unchanged; §11 `pin: false` objects (state blobs) are served to peer hosts by `POST /peer { kind: "object", cid }`, and a `fetch ipfs:` the host can't answer asks its peer hosts, keeping only bytes that hash to the CID.

**Amended 2026-11-15 (6.4), for David's review; security items D1, D2, D4 and D8 approved by David 2026-11-19, the rest still for review** (`plans/notary-questions-6.4.md`): §10 `chain_submit.calldata` is the object the enclave names, submitted unchanged; `fetch protocol_version` and `press_auth:<policy>,<press>`; operator route `POST /operator/template-seed`.

**Amended 2026-11-14 (6.3):** §11 the peer directory, `tick`, and `need_inputs` ciphertext sync. David approved 2026-11-14 (`plans/notary-questions-phase-6.md`, Q5–Q9). Also relaying log records and storing acknowledged inputs (`store_input`), approved by David 2026-11-15 (`plans/notary-questions-6.3.md`).

**Amended 2026-11-14 (6.2):** §5 `POST /jobs/{job_hash}/restart`. A consequence of the approved Phase 6 plan (6.2), not covered by an earlier approval; **for David's review** (`plans/notary-questions-phase-6.md`).

**Amended 2026-11-14 (6.0a):** §8 `policy_head_cid`; snapshots go out when a job is created and gate its announcement. A consequence of the approved Q2 wording, found while implementing it; **for David's review** (`plans/notary-questions-phase-6.md`, Q2).

**Amended 2026-11-23 (7.4 review, documenting what the code does):** §4 `ENCLAVE_ENDPOINTS` entries are matched to `ENCLAVE_CIDS` by CID; `IPFS_PROVIDER` is `mock`, `kubo` or `sim`; `GAS_BALANCE_LOW_WEI`; `EXPECTED_CHAIN_ID` is checked against the RPC at start; §5 `POST /operator/template-seed`; §13 which alerts the host raises; §14 `NH_MALFORMED`.  
**Amended 2026-11-23 (Phase 7, Q7):** §4 `CHAIN_PROVIDER=rpc` starts with the production clients; `REGISTRY_STORAGE_ADDRESS`, `NOTARY_DELIVERY_URL`; header feed needs `debug_getRawHeader`.  
**Amended 2026-11-13 (5.7 review):** §4 `NOTARY_CARD_ADDRESSES` is optional and genesis cards are served automatically (Q4); §4 `CHAIN_PROVIDER`, `SIM_CHAIN_URL` and the start-up refusal; §14 `NOT_REACHABLE`, `ENCLAVE_ERROR` (Q5, Q6). Source: `plans/notary-questions-5.7.md`, David approved 2026-11-13 (`plans/notary-questions-5.7.md`).

**Amended 2026-11-12 (batch 2):** §4 adds `ENCLAVE_ENDPOINTS`, `NOTARY_ADMIN_TOKEN`, `NOTARY_RELAY_TARGET_ID` and `NOTARY_PUBLIC_BASE_URL`, and `K_host` is a 32-byte seed; §5 genesis routes use the admin token; §9 anchor encoding; §14 adds `NH_UNAUTHORIZED` (E18, E3, E16). Source: `plans/notary-spec-wording-batch2.md`, approved by David 2026-11-12.

> **Terminology.** The notary host is a **nitropack** application, built on the same server framework as the press (which `press.md` calls "Nitro"). It runs on the parent EC2 instance of one or more **AWS Nitro Enclaves** enclaves, which run the notary runtime. See `ARCHITECTURE.md`, terminology note.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Trust Position](#2-trust-position)
3. [Deployment](#3-deployment)
4. [Configuration](#4-configuration)
5. [HTTP Endpoints](#5-http-endpoints)
6. [Relay Registration and Oblivious Ingress](#6-relay-registration-and-oblivious-ingress)
7. [Storage](#7-storage)
8. [Chain Feed: Headers, Policy Snapshots and Updates](#8-chain-feed-headers-policy-snapshots-and-updates)
9. [Publishing: IPFS and EAS](#9-publishing-ipfs-and-eas)
10. [Registry Writes](#10-registry-writes)
11. [Enclave Management and Peer Relay](#11-enclave-management-and-peer-relay)
12. [Output Delivery](#12-output-delivery)
13. [Monitoring](#13-monitoring)
14. [Error Codes](#14-error-codes)
15. [Related Specs](#15-related-specs)

---

## 1. Overview

The notary host is the operator's service. It connects the outside world to the operator's enclaves:
- it accepts sealed inputs through the relay;
- it serves job announcements;
- it stores ciphertexts;
- it keeps enclaves supplied with chain data;
- it pins records to IPFS, anchors job logs with EAS, submits the enclave-signed derived-card writes, and relays traffic between replicas.

It never sees an input's content, a job key, or a notary card key.

Code lives in `notary/host/`, a TypeScript nitropack service following the `press/` layout. It reuses the press's IPFS providers, `viem` registry client, OHTTP gateway, RFC 8785 serializer and KV abstraction (`plans/notary-spec-impact.md §E`). It is deployed with `notary/deploy/` (Docker Compose plus the enclave image).

---

## 2. Trust Position

The host is **untrusted** for confidentiality and integrity. `notary_lifecycle.md` §Threat Model treats it as fully adversarial for I/O. Everything it sends to an enclave is checked there.

The host **is** responsible for availability and accountability:

| Duty | Evidence that holds it to account |
|---|---|
| Accepting inputs | `HostReceipt` signed with `K_host` |
| Keeping ciphertexts until close | `dropped_after_acceptance` in the notarization, plus contributors' receipts |
| Anchoring job-log records | Enclaves stop until each anchor exists; gaps are visible on EAS |
| Starting replacement replicas | `replica_lost` and `replicated` records |
| Relaying peer traffic and chain data | Stalls are visible to every operator in the replica set |

**Keys the host holds:**
- `K_host` (ML-DSA-44), for receipts;
- the OHTTP gateway key (X25519);
- the gas wallet (secp256k1).

The gas wallet only pays gas. It signs no protocol payload, the same split as the press (`press.md §2`).

---

## 3. Deployment

- **Instance.** One enclave-capable EC2 instance (Graviton, at least 2 vCPU) per availability zone, each running the host and one or more enclaves. AWS allows up to four enclaves per parent instance.
- **Default replica layout.** Three instances across three availability zones. For votes, replicas from more than one operator are recommended.
- **Container setup.** Docker Compose runs the host, a Redis KV store, and a vsock proxy. The enclave image (EIF) is built reproducibly from `notary/deploy/`, and its PCR0 must be on the accepted-runtime list.
- **Development and CI.** Run against `notary/sim`, the local enclave simulator, with a test attestation root. No AWS resources are created until the operator provisions them.

---

## 4. Configuration

All configuration is through environment variables.

| Variable | Required | Description |
|---|---|---|
| `NOTARY_CARD_ADDRESSES` | No | Comma-separated notary card addresses this operator serves, for cards created elsewhere or before this host started. A card created through `POST /genesis` on this host is served at once and remembered in the host's storage, so no card address is needed to run genesis for the first time and no restart follows. |
| `NOTARY_HOST_MLDSA44_PRIVATE_KEY` | Yes | `K_host`, for host receipts, as a 32-byte ML-DSA-44 seed (base64url). Its public key must equal `operator_host_pubkey` on each notary card. |
| `NOTARY_OHTTP_PRIVATE_KEY` | Yes | X25519 HPKE key for the gateway (§6) |
| `NOTARY_GAS_WALLET_PRIVATE_KEY` | Yes | Pays gas for derived-card writes and EAS anchors |
| `ARBITRUM_RPC_URL`, `EXPECTED_CHAIN_ID`, `REGISTRY_CONTRACT_ADDRESS` | Yes | As in `press.md §3.2`. `REGISTRY_CONTRACT_ADDRESS` is the registry's **logic** contract (writes and events). The chain feed's header RLP needs an RPC endpoint with the `debug_getRawHeader` method. |
| `REGISTRY_STORAGE_ADDRESS` | With `CHAIN_PROVIDER=rpc` | The registry's storage contract (card entries, press authorizations, sub-cards). |
| `NOTARY_DELIVERY_URL` | With `CHAIN_PROVIDER=rpc` | The wallet service the host sends `notary_output` messages through (`POST /messages`). On `410 card_migrated` the envelope is sent once to the endpoint the answer names. The host does not look up a recipient's wallet service in the peer registry. |
| `EAS_CONTRACT_ADDRESS`, `NOTARY_EAS_SCHEMA_UID` | Yes | The EAS job-log schema |
| `IPFS_PROVIDER` and provider variables | Yes | `kubo` (with `KUBO_API_URL`), `mock` (in memory, for tests) or `sim` (the simulated chain's). Unlike the press, there is no `filebase` provider, and `kubo` is the production one. |
| `EXTERNAL_KV_URL` | Yes | Redis, for durable host state (§7) |
| `ENCLAVE_CIDS` | Yes | vsock context IDs of local enclaves |
| `ENCLAVE_ENDPOINTS` | Yes | How to reach each `ENCLAVE_CIDS` entry: comma-separated `cid=unix:/path` or `cid=host:port` entries, matched to `ENCLAVE_CIDS` by `cid` (the vsock proxy address in production, a local socket in the simulator) |
| `NOTARY_ADMIN_TOKEN` | Yes | Bearer token for the operator-authenticated routes (§5). Compared in constant time. |
| `NOTARY_RELAY_TARGET_ID` | Yes | The `target_id` registered with the relay, put in announcement `transport` hints |
| `NOTARY_PUBLIC_BASE_URL` | Yes | This host's public URL, put in announcement `transport` hints |
| `PEER_HOSTS` | No | URLs of other operators' hosts, for cross-operator replicas (§11) |
| `SNAPSHOT_REFRESH_SECONDS` | No | Default 30 |
| `REATTEST_INTERVAL_SECONDS` | No | Default 21600 (6 hours). **Read but not used yet:** see §11 "Re-attestation". |
| `GAS_BALANCE_LOW_WEI` | No | The gas wallet balance, in wei, below which the `gas_balance_low` alert is raised. Default 10000000000000000 (0.01 ETH). With `CHAIN_PROVIDER=rpc` only. |
| `ALERT_WEBHOOK_URL` | No | Operator alerting |
| `CHAIN_PROVIDER`, `SIM_CHAIN_URL` | No | `CHAIN_PROVIDER` is `rpc` (default) or `sim`. `sim` and `SIM_CHAIN_URL` select the simulated chain, EAS and IPFS and are for the simulator stack only. `rpc` runs the production clients (`notary/host/src/chain/rpc.ts`: registry reads and chain feed, gas-wallet submitter, EAS anchorer; Kubo for IPFS; a wallet-service delivery client) and **requires** `IPFS_PROVIDER=kubo`, `REGISTRY_STORAGE_ADDRESS` and `NOTARY_DELIVERY_URL`. The host **refuses to start** with `CHAIN_PROVIDER=rpc` and any other `IPFS_PROVIDER`, with `IPFS_PROVIDER=kubo` and `CHAIN_PROVIDER=sim`, and with a `memory:` `EXTERNAL_KV_URL` unless `CHAIN_PROVIDER=sim`. It never falls back to in-memory services. A host running simulated components says so in a warning at start-up. |

---

## 5. HTTP Endpoints

| Method | Path | Reached through | Description |
|---|---|---|---|
| `GET` | `/ohttp/key-config` | Direct | The gateway's HPKE key configuration (`oblivious_transport.md`) |
| `POST` | `/ohttp/gateway` | The relay | Oblivious-transport gateway. Decapsulates and dispatches to the routes marked "oblivious" below. |
| `GET` | `/jobs/{job_hash}/announcement` | Oblivious | The newest `JobAnnouncement` for the highest epoch |
| `POST` | `/jobs/{job_hash}/inputs` | Oblivious | Body is a `SealedInput` (`protocol-objects.md §24`). Stores it, signs a `HostReceipt`, forwards it to a local enclave, and returns `{ host_receipt, receipt_sealed }`. |
| `POST` | `/jobs` | Direct, from the job requester | Body: `{ job, program_cid }`. The host fetches the program and sends `create_job`. Returns `{ job_hash, status }`. *(6.3, approved by David 2026-11-15, `plans/notary-questions-6.3.md` R12:)* with N > 1 only the host serving the first `replica_set` card sends `create_job`; another host records the job and answers `status: "awaiting_handoff"`. |
| `POST` | `/operator/handoff` | Direct, `NOTARY_ADMIN_TOKEN` | *(6.3, approved by David 2026-11-15, R5)* Body `{ scope, card, template?, from_instance?, to_instance }`: an identity or template handoff between instances (`start_handoff`) |
| `POST` | `/operator/template-seed` | Direct, `NOTARY_ADMIN_TOKEN` | *(6.4)* Body `{ template, notary_card, nullifier_period }`: seeds the template's `dup_tag` key in the first enclave serving it (`seed_template`). Returns `{ status: "seeded", generation }`. |
| `POST` | `/operator/shutdown` | Direct, `NOTARY_ADMIN_TOKEN` | *(6.3, approved by David 2026-11-15, R5)* Body `{ instance }`: the instance tells its peers it stops (`shutdown`) |
| `POST` | `/jobs/{job_hash}/restart` | Direct, `NOTARY_ADMIN_TOKEN` | Body `{ reason }` (default `total_loss`). The operator reports that no replica holds the job key. The host sends `create_job` with `restart { prev_epoch, last_log, reason }` (the epoch it holds and its newest job-log record) to a local enclave, stops serving the old announcement, and serves the new epoch's only after the enclave announces it (`notary_replication_and_recovery.md` §7). Returns `{ job_hash, epoch, status }`. |
| `GET` | `/jobs/{job_hash}/status` | Direct | Public status only: state, epoch, live replica count, job-log head CID |
| `POST` | `/genesis` | Direct, `NOTARY_ADMIN_TOKEN` | Starts notary genesis (`notary_lifecycle.md` Phase 0) and returns the genesis request and attestation. The host then serves the new notary card (§4). |
| `POST` | `/genesis/countersign` | Direct, `NOTARY_ADMIN_TOKEN` | Passes the policy holder's notary card offer to the enclave and returns the countersigned offer |
| `POST` | `/peer` | Direct, from peer hosts | Relays peer messages (handoff, `input_ack`, cosignatures, heartbeats) to the named local instance. *(6.3)* With `kind`: `directory` (this host's instances, Q5), `inputs` (stored ciphertexts by hash, Q8), and (R2, approved by David 2026-11-15), `log_record`, `anchor` and `announce` (records, anchors and announcements other hosts' enclaves produced) |
| `GET` | `/health` | Direct | Liveness, plus the number of attested enclaves |

The announcement and input routes are reached **only** through the gateway. A direct request to them is refused (`NH_DIRECT_FORBIDDEN`), the same pattern the press uses for its sensitive routes.

Responses are JSON. Errors are `{ "error": "<code>", "message": "<text>" }`.

---

## 6. Relay Registration and Oblivious Ingress

- **A third destination kind.** The notary host is one, alongside the wallet service and the press (`oblivious_transport.md`). The operator registers a `target_id` with the relay; it appears in announcements and share links.
- **Two envelopes.** The gateway removes only the **outer** envelope. The body it dispatches is a `SealedInput` (or a `NotaryCountersign`, sealed the same way), encrypted to the enclave's job key. The host can't open it.
- **The response** goes back through the outer HPKE context. It contains:
  - the `HostReceipt`;
  - `receipt_sealed`, the `ValidationReceipt` sealed under a key exported from the inner context (`protocol-objects.md §24`), which the host can't read.

---

## 7. Storage

| Key | Value | Retention |
|---|---|---|
| `job:{job_hash}` | Job, latest announcement, epoch, replica list | Until the job is finalized or ended, plus 30 days |
| `input:{job_hash}:{epoch}:{input_hash}` | `SealedInput` bytes and receipt time | Until the job is finalized (aggregate jobs) or the input's run completes (per-input jobs). **Then deleted.** |
| `receipt:{input_hash}` | The `HostReceipt` | 30 days |
| `snapshot:{policy_address}` | Policy snapshot and its block | While any job depends on that policy |
| `blob:{notary_card}:{version}` | Encrypted state blob and header | The current version and the previous version |
| `log:{scope_id}` | Job-log and identity-log record CIDs and anchor transaction hashes | Permanent; the records themselves are public |

The host stores only ciphertexts, receipts and public objects. It never stores a decrypted input, a job key, or the link between a source card and a derived card.

---

## 8. Chain Feed: Headers, Policy Snapshots and Updates

- **Headers.** The host streams new Arbitrum One block headers to each enclave (`chain_headers`). On request (`fetch`) it supplies the headers that link to a wallet's `chain_ref`.
- **Policy snapshots.** For each policy a live job depends on, the host builds and keeps current a snapshot. Relevant policies are the derived-card job's `source_policy`, and each `issued_under_template` policy in `contributor_predicate`. The snapshot contains:
  - every `CardRegistered` and `CardHeadUpdated` under the policy, giving each card's address, current head CID and last press address, and its head-event history `events: [{ cid, timestamp }]` (the block timestamp of each event, oldest first). Card checks use it for provenance and for authoritative revocation dates;
  - the `SubCardRegistrations` entries whose primary card is in the set, each with `master_card`, `sub_card`, `sub_card_doc_cid` and `active`;
  - the IPFS bytes of each current head.

  The snapshot names the policy card's current head (`policy_head_cid`). A job's snapshots are sent as soon as the job exists, and the host serves the job's announcement only after every snapshot has reached the enclaves, so that no input can arrive before the enclave can read its contributor's own cards (`notary_runtime.md §9`, `fetch`). It is sent as `policy_snapshot`, then `policy_updates` every `SNAPSHOT_REFRESH_SECONDS`. `policy_updates` entries also carry `timestamp`.
- **Never filtered.** The host must send **every** update under the policy. It is never told which cards matter, and must not filter. That is what keeps the source card hidden (`derived_card_revocation_propagation.md` §2).
- **Per-card fetches.** These are answered for ancestors outside snapshotted policies, for the disclosed fallback, for policy and requester reads (algorithm R; jobs are public), and for list cards. The host can log them; they reveal issuers, policies and requesters, not contributors. Shapes: `card_head:<address>` → RFC 8785 JSON `{ "head_cid", "events": [{ "cid", "timestamp" }] }`; `subcard:<address>` → `{ "master_card_address", "sub_card_doc_cid", "active" }`.
- **List cards.** The runtime reads the two governance list cards through per-card fetches (`notary_runtime.md` §12) and verifies them against its pinned keys, including each version's member `list_approval` (algorithm L).

---

## 9. Publishing: IPFS and EAS

- **Pinning.** The host pins every object an enclave publishes:
  - announcements, notarizations and `counted_inputs`;
  - job-log and identity-log records;
  - derived cards (encrypted, as for any card);
  - state blobs.

  Each object is pinned as the exact bytes the enclave produced, using the `raw` codec for public notary objects (`protocol-objects.md`, notary conventions).
- **Anchoring.** For every record of an anchored kind, the host submits an EAS attestation `(job_hash, seq, record_cid)`, encoded as in `protocol-objects.md §28`, under the notary schema from the gas wallet, then returns the transaction receipt to the enclave (`anchor_receipt`). The enclave signs nothing further in that log until it sees the receipt.

---

## 10. Registry Writes

For derived-card template policies only:
- The enclave's identity leader signs `RegisterCard` and `BatchUpdateCardHeads` payloads with `K_chain`.
- The host submits them from the gas wallet **unchanged**, using the calldata the enclave specified (`chain_submit`).
- The host reports the result as `chain_result`.

**Prerequisite (met on the devnode).** The write gate binds each signed payload to its calldata (`registry_contract.md §6.1`, step 6.4a), so a host cannot resubmit a signed payload with other calldata. Deploying that gate beyond the devnode is W8.

---

## 11. Enclave Management and Peer Relay

- **Starting enclaves.** The host starts enclaves from the pinned image and sends `hello`. It answers `need_replica` by starting a new enclave, preferably in another availability zone, and introducing it to the replica that asked, so the handoff can run (`notary_replication_and_recovery.md` §3).
- **Peer relay.** Traffic between replicas goes through `peer_send` from the sending enclave, then the sending host's `POST /peer` call to the receiving host, then the receiving host's `peer_message` to its enclave. Hosts see only signed or sealed bytes.
- **Peer directory** *(added 2026-11-14, Q5)*. The host sends each enclave `peer_directory`: the instances it knows of for the enclave's jobs and cards (its own and those reached through `PEER_HOSTS`), each with `notary_card`, `inst_pubkey`, `attestation` and `host_url`. It is only a routing hint; enclaves trust nothing in it.
- **Ticks** *(added 2026-11-14, Q6)*. The host sends each enclave `tick {}` about once a second. Withholding ticks only slows the enclave's timers.
- **Ciphertext sync** *(added 2026-11-14, Q8)*. On `need_inputs { job_hash, hashes }` the host fetches each missing `SealedInput` from peer hosts through `/peer`, checks `H(sealed) == input_hash` itself, and stores it under `input:` (§7). A host can withhold an input, never inject one. On `store_input` it stores an input its enclave acknowledged for a peer, with the same check (approved by David 2026-11-15 (`plans/notary-questions-6.3.md`, R4)).
- **Log records** (approved by David 2026-11-15 (`plans/notary-questions-6.3.md`, R2)). The host relays every job-log and identity-log record its enclave publishes to the other hosts of the replica set, and gives its enclave the records the others wrote (`log_record`, and `anchor_receipt` with `record` once anchored).
- **Re-attestation.** Every `REATTEST_INTERVAL_SECONDS` the host asks each enclave to re-attest its live jobs, then serves the re-issued announcement. *(Not implemented: the enclave has no request for it. An announcement's attestation is re-issued at an epoch change or a handoff. Wallets refuse an announcement whose attestation is older than their `maxAttestationAgeSeconds` (86,400 by default), so a job that runs longer than that needs this. Open: it needs a new host-to-enclave message, so a runtime change.)*
- **Restarts.** After a total loss, the operator may restart a job (`create_job` with `restart`, `notary_replication_and_recovery.md` §7). The resulting epoch change is public.
- **Stalled close** *(added 2026-11-15, R9)*. When a leader is lost mid-close and no live replica holds its card's key (`notary_replication_and_recovery.md` step 19a), the job can't produce a result. The operators:
  1. **Notice it.** Replicas raise `close_conflicting_body`, the job log has no `notarized` record well after `closes_at`, and its last records show the leader's `replica_lost` after close began.
  2. **Try the automatic path first.** If the lost leader's operator still runs another instance of that notary card that holds the job and co-signed the body, it takes over by itself. Starting a *new* instance of the card doesn't help: it never saw the body.
  3. **Otherwise abort the job.** The operator of the current leader sends its replica `abort_job` with reason `close_stalled`. The leader writes an `aborted` record; once it is anchored, every replica follows it and erases the job's keys, and every host deletes the job's ciphertexts. (Only the leader writes the record; an `abort_job` sent to another replica would fork the log.) **The host has no operator route for `abort_job` yet.**
  4. **The requester issues a new job**: a new `nonce`, so a new `job_hash`, preferably with replicas spread so that no single operator's loss takes out the leader's card. Contributors consent and submit again. Their stored inputs are signed for the old `job_hash`, so wallets can't resend them without the contributor, unlike after an epoch restart. Wallets should tell users that the job ended without a result.
  5. Nothing is disclosed in any of this. No input was published, the keys are erased, and the stalled job's `aborted` record is public.

---

## 12. Output Delivery

For private `statement` outputs, the enclave produces `notary_output` messages already encrypted to each recipient's sub-cards (`messaging_protocol.md §24`). The host delivers them through ordinary message routing, as a sender (`deliver`). It can't read them.

---

## 13. Monitoring

Alerts never contain job data. They cover:
- the number of attested enclaves (`enclaves_attested`: fewer live sessions than configured);
- per-job live replica counts against `min_live` (`replicas_below_min_live`);
- anchor backlog (`anchor_backlog`);
- gas balance (`gas_balance_low`: below `GAS_BALANCE_LOW_WEI`, or unreadable; the production chain only);
- snapshot lag (`snapshot_lag`: no full snapshot pass for more than three refresh intervals);
- `close_mismatch`;
- `LIST_VERSION_REGRESSION`.

The host raises the first, second, fourth and fifth itself, every 30 seconds, and repeats one at most every five minutes. It also raises `storage_failure`, `delivery_failed`, `close_failed`, `enclave_lost` and `need_replica_failed` where those happen, and forwards the alerts its enclaves send (for example `press_unreadable`, when a listed press pointer in a source policy cannot be read; that press is skipped, the rest still count).

Heartbeats themselves stay between enclaves and are never published.

---

## 14. Error Codes

| Code | Meaning |
|---|---|
| `NH_DIRECT_FORBIDDEN` | An oblivious-only route was called directly |
| `NH_JOB_UNKNOWN` | No such job on this host |
| `NH_JOB_CLOSED` | The job is finalized or ended |
| `NH_ENCLAVE_UNAVAILABLE` | No local enclave holds the job; retry |
| `NH_INPUT_TOO_LARGE` | `SealedInput` larger than 256 KiB |
| `NH_STORAGE_FAILED` | The ciphertext couldn't be stored; no receipt is issued |
| `NH_MALFORMED` | A replication request (`POST /peer`, `kind` bodies) had a missing or malformed field |
| `NH_UNAUTHORIZED` | An operator-authenticated route was called without a valid token (HTTP 401) |
| `NOT_REACHABLE` | A request through the gateway named a route that isn't an oblivious route (HTTP 404) |
| `ENCLAVE_ERROR` | The enclave answered with an error that carried no code |
| Enclave codes | Passed through unchanged (`notary_runtime.md §16`) |

---

## 15. Related Specs

- `object_specs/notary_runtime.md`: the enclave side of §8–§12
- `process_specs/notary_lifecycle.md`, `notary_replication_and_recovery.md`, `derived_card_revocation_propagation.md`
- `process_specs/oblivious_transport.md`, `object_specs/relay.md`: ingress
- `object_specs/press.md`: shared patterns (nitropack layout, IPFS, KV, gas wallet)
- `object_specs/registry_contract.md` §4.1, §4.15, §6.1
- `ARCHITECTURE.md` ADR-008 (EAS), ADR-013
