# Card Protocol — Notary Host Spec

**Version:** 0.1 (draft)  
**Date:** 2026-11-11  
**Status:** Draft. Specified, not implemented.  
**Architecture:** `ARCHITECTURE.md` ADR-013 · **Runtime:** `object_specs/notary_runtime.md` · **Processes:** `process_specs/notary_lifecycle.md`, `notary_replication_and_recovery.md`, `derived_card_revocation_propagation.md`
**Amended 2026-11-12:** §8 snapshot entries carry head-event history and `sub_card_doc_cid`; per-card fetch shapes defined; policy, requester and list-card reads use per-card fetches. Source: `plans/notary-spec-wording-e31.md`, approved by David 2026-11-12.

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
| `ARBITRUM_RPC_URL`, `EXPECTED_CHAIN_ID`, `REGISTRY_CONTRACT_ADDRESS` | Yes | As in `press.md §3.2` |
| `EAS_CONTRACT_ADDRESS`, `NOTARY_EAS_SCHEMA_UID` | Yes | The EAS job-log schema |
| `IPFS_PROVIDER` and provider variables | Yes | As in `press.md §3.2` |
| `EXTERNAL_KV_URL` | Yes | Redis, for durable host state (§7) |
| `ENCLAVE_CIDS` | Yes | vsock context IDs of local enclaves |
| `ENCLAVE_ENDPOINTS` | Yes | How to reach each `ENCLAVE_CIDS` entry, in the same order: the vsock proxy address in production, a local socket in the simulator |
| `NOTARY_ADMIN_TOKEN` | Yes | Bearer token for the operator-authenticated routes (§5). Compared in constant time. |
| `NOTARY_RELAY_TARGET_ID` | Yes | The `target_id` registered with the relay, put in announcement `transport` hints |
| `NOTARY_PUBLIC_BASE_URL` | Yes | This host's public URL, put in announcement `transport` hints |
| `PEER_HOSTS` | No | URLs of other operators' hosts, for cross-operator replicas (§11) |
| `SNAPSHOT_REFRESH_SECONDS` | No | Default 30 |
| `REATTEST_INTERVAL_SECONDS` | No | Default 21600 (6 hours) |
| `ALERT_WEBHOOK_URL` | No | Operator alerting |
| `CHAIN_PROVIDER`, `SIM_CHAIN_URL` | No | `CHAIN_PROVIDER` is `rpc` (default) or `sim`. `sim` and `SIM_CHAIN_URL` select the simulated chain, EAS and IPFS and are for the simulator stack only. Until the production chain, EAS, gas-wallet and Kubo clients exist (Phase 7) the host **refuses to start** with `CHAIN_PROVIDER=rpc` or `IPFS_PROVIDER=kubo`, and with a `memory:` `EXTERNAL_KV_URL` unless `CHAIN_PROVIDER=sim`. It never falls back to in-memory services. A host running simulated components says so in a warning at start-up. |

---

## 5. HTTP Endpoints

| Method | Path | Reached through | Description |
|---|---|---|---|
| `GET` | `/ohttp/key-config` | Direct | The gateway's HPKE key configuration (`oblivious_transport.md`) |
| `POST` | `/ohttp/gateway` | The relay | Oblivious-transport gateway. Decapsulates and dispatches to the routes marked "oblivious" below. |
| `GET` | `/jobs/{job_hash}/announcement` | Oblivious | The newest `JobAnnouncement` for the highest epoch |
| `POST` | `/jobs/{job_hash}/inputs` | Oblivious | Body is a `SealedInput` (`protocol-objects.md §24`). Stores it, signs a `HostReceipt`, forwards it to a local enclave, and returns `{ host_receipt, receipt_sealed }`. |
| `POST` | `/jobs` | Direct, from the job requester | Body: `{ job, program_cid }`. The host fetches the program and sends `create_job`. Returns `{ job_hash, status }`. |
| `GET` | `/jobs/{job_hash}/status` | Direct | Public status only: state, epoch, live replica count, job-log head CID |
| `POST` | `/genesis` | Direct, `NOTARY_ADMIN_TOKEN` | Starts notary genesis (`notary_lifecycle.md` Phase 0) and returns the genesis request and attestation. The host then serves the new notary card (§4). |
| `POST` | `/genesis/countersign` | Direct, `NOTARY_ADMIN_TOKEN` | Passes the policy holder's notary card offer to the enclave and returns the countersigned offer |
| `POST` | `/peer` | Direct, from peer hosts | Relays peer messages (handoff, `input_ack`, cosignatures, heartbeats) to the named local instance |
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
  - the `SubCardRegistrations` entries whose master card is in the set, each with `master_card`, `sub_card`, `sub_card_doc_cid` and `active`;
  - the IPFS bytes of each current head.

  It is sent as `policy_snapshot`, then `policy_updates` every `SNAPSHOT_REFRESH_SECONDS`. `policy_updates` entries also carry `timestamp`.
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

**Prerequisite.** The write gate must bind each signed payload to its calldata (`registry_contract.md §6.1`) before derived cards ship. Until then, a host could resubmit a signed payload with other calldata.

---

## 11. Enclave Management and Peer Relay

- **Starting enclaves.** The host starts enclaves from the pinned image and sends `hello`. It answers `need_replica` by starting a new enclave, preferably in another availability zone, and introducing it to the replica that asked, so the handoff can run (`notary_replication_and_recovery.md` §3).
- **Peer relay.** Traffic between replicas goes through `peer_send` from the sending enclave, then the sending host's `POST /peer` call to the receiving host, then the receiving host's `peer_message` to its enclave. Hosts see only signed or sealed bytes.
- **Re-attestation.** Every `REATTEST_INTERVAL_SECONDS` the host asks each enclave to re-attest its live jobs, then serves the re-issued announcement.
- **Restarts.** After a total loss, the operator may restart a job (`create_job` with `restart`, `notary_replication_and_recovery.md` §7). The resulting epoch change is public.

---

## 12. Output Delivery

For private `statement` outputs, the enclave produces `notary_output` messages already encrypted to each recipient's sub-cards (`messaging_protocol.md §24`). The host delivers them through ordinary message routing, as a sender (`deliver`). It can't read them.

---

## 13. Monitoring

Alerts never contain job data. They cover:
- the number of attested enclaves;
- per-job live replica counts against `min_live`;
- anchor backlog;
- gas balance;
- snapshot lag;
- `close_mismatch`;
- `LIST_VERSION_REGRESSION`.

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
