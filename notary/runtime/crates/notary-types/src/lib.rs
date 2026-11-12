//! notary-types — shared notary objects and canonical forms.
//!
//! Implements: protocol-objects.md §Notary Objects — Conventions, §20–§34; notary_runtime.md §5.
//! Decisions: plans/notary-questions-phase-5.md Q6 (strict numbers/no null/unknown fields),
//! Q7 (strict base64url, timestamps, durations, card pointers, CIDs), E1 (empty Merkle root).
//! The TypeScript twin is membership_card_verifier/packages/verifier/src/notary; both are
//! checked against notary/vectors/.

pub mod b64u;
pub mod error;
pub mod formats;
pub mod jcs;
pub mod merkle;
pub mod objects;
pub mod user_data;

pub use error::NotaryError;
