Notary Systems and Verifiable Computation

Summary
The pattern explored here: trusted wrapper/oracle scripts that observe data or run computations and produce signed attestations — three concrete cases being a WhatsApp message-signing wrapper, an EventBrite API wrapper, and a survey-aggregation wrapper that signs transformations of multiple inputs. In each case, the output is a signed Card or a signed attestation that can be treated as a link in a Card chain.

Prior Art
For wrapping external services (cases 1 and 2), this is the zkTLS / oracle / notary family: TLSNotary, DECO, Reclaim Protocol, Town Crier, Chainlink, with DKIM as a deployed-but-narrow ancestor. Reclaim is the closest productized match.

For attesting transformations (case 3), this is verifiable computation: TEE attestation (SGX, Nitro, Apple's Private Cloud Compute), zkVMs (RISC Zero, SP1), and Prio — which is purpose-built for the survey-aggregation case specifically.

Cross-cutting: W3C Verifiable Credentials provide a natural data-model envelope; C2PA's signed-transformation chains structurally resemble case 3; authenticated data structures handle the "query against large dataset" variant.

Relationship to the Card Press
Notary systems and the Card Press are related but distinct. The Card Press is a gated enclave that issues Cards according to approved policies. Notary systems are a broader family of attested computation that can serve as inputs to a Card Press — for example, a Reclaim-style HTTPS attestation can be the evidence required by a policy before the Press will issue a Card. The notary's signed output is a verifiable input; the Card Press's signed output is the credential.

Zero-Knowledge Extensions
Zero-knowledge extensions split into two distinct properties:

Predicate hiding — the attester sees raw data but proves only a statement about it. Implemented via zkSNARKs over circuits that encode signature checks, transformations, and the asserted predicate. Reveals the predicate; hides everything else. This is what Reclaim and DECO do.

Attester blindness — the attester doesn't see plaintext at all. Three substrates: TEEs (trust hardware), MPC with non-colluding aggregators (trust at-least-one-honest, the Prio/DAP model), or FHE (trust the math, pay in performance).

The properties compose. The natural design for the survey-aggregation case combines them: respondents send encrypted inputs with SNARK range proofs; an aggregator (TEE or MPC) computes blindly and issues a signed output Card with an aggregation proof. This slots into the existing chain-verification model as just another link whose issuer happens to be attested code — the same pattern as the Card Press itself.

Key Tradeoffs
SNARK proving time: generating proofs is computationally expensive; verifying them is cheap.
Circuit engineering complexity: encoding the desired computation as a ZK circuit is nontrivial.
Trusted-setup choice: favor transparent schemes (STARKs, PLONK with transparent setup) given the protocol's decentralization ethos, rather than schemes requiring a trusted ceremony.
TEE hardware trust: TEEs require trusting the hardware manufacturer's attestation infrastructure. This is a philosophical tradeoff relative to pure cryptographic trust.

Practical recommendation: pick one ZK property for v1 rather than both. Predicate hiding (Reclaim-style) is simpler to deploy and covers the majority of attestation use cases.
