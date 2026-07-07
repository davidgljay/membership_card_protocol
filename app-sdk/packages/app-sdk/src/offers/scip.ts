/**
 * `SCIP` (Signed Card Inclusion Proof) — `protocol-objects.md §10`.
 * Produced by the press, delivered to the recipient, retained as
 * verifiable proof of issuance. This is a pure data shape shared by both
 * the offerer-side press-finalization flow this package implements
 * (`targetedOfferAcceptance.ts`) and Wallet SDK's own open-offer claim
 * submission — verifying `press_signature` is out of scope for either
 * module that merely parses and carries this type.
 */
export interface Scip {
  card_cid: string;
  policy_log_entry_index: number;
  policy_log_root_at_inclusion: string;
  issued_at: string;
  press_signature: { public_key: string; signature: string };
}
