/**
 * Acceptance criterion G1 (card_protocol_spec.md section 9): "All four use cases run on real AWS Nitro Enclaves at least once,
 * not only in the simulator", and G5: "Integration tests derived from this section pass against the local simulator and against
 * AWS Nitro Enclaves."
 *
 * DEFERRED until David provisions AWS (Phase 8; notary-implementation-plan.md 8.1 and 8.2). There is no enclave image
 * (`notary/deploy/eif/`), no real attestation backend and no AWS account behind this repository yet, so these are skipped on
 * purpose. They are listed so the deferral shows in every run (vitest reports them as skipped) and cannot be mistaken for a pass.
 */
import { describe, it } from 'vitest';

describe.skip('notary on real AWS Nitro Enclaves (deferred to Phase 8)', () => {
  it('aggregation runs on a real enclave and verifyNotarization accepts it', () => {});
  it('a vote runs on a real enclave and its tally verifies', () => {});
  it('derived cards are issued by a real enclave and pass standard verification', () => {});
  it('sealed_link revocation runs on a real enclave', () => {});
  it('the spec-derived suites in notary/e2e pass against the real enclave, not only the simulator', () => {});
});
