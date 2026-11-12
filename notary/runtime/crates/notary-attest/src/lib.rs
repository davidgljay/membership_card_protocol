//! notary-attest — attestation backends and verifier modules.
//!
//! Implements: notary_runtime.md §5 (backends, verifier modules), notary_lifecycle.md Appendix A.1
//! (algorithm V), protocol-objects.md §33.
//!
//! **G5 (AWS format isolation).** Only `aws` (and `sim`, which calls it with a test root) may parse
//! or produce the AWS Nitro Enclaves attestation document. `verify` (V6–V12) works on the parsed
//! `Envelope` and never sees the document format.
pub mod aws;
pub mod sim;
pub mod verify;

/// Failure to produce an attestation document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttestError(pub String);

impl std::fmt::Display for AttestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "attestation failed: {}", self.0)
    }
}
impl std::error::Error for AttestError {}

/// notary_runtime.md §5: what the broker uses to obtain an attestation document.
pub trait AttestationBackend {
    /// Returns the attestation document bytes. `user_data` is 181 bytes (§33); `public_key` and `nonce` are 32 bytes.
    fn attest(&self, user_data: [u8; 181], public_key: Option<[u8; 32]>, nonce: [u8; 32]) -> Result<Vec<u8>, AttestError>;
    /// `"aws-nitro-enclaves"` or `"simulator"`.
    fn platform(&self) -> &'static str;
}

/// The result of steps V1–V5, platform independent (the Rust twin of the TypeScript `verifyEnvelope` result).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Envelope {
    pub measurement: Vec<u8>, // PCR0
    pub pcrs: std::collections::BTreeMap<u32, Vec<u8>>,
    pub timestamp_ms: u64,
    pub user_data: Vec<u8>,
    pub nonce: Option<Vec<u8>>,
    pub public_key: Option<Vec<u8>>,
}

/// Codes of V1–V5 (notary_runtime.md §5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvelopeCode {
    Malformed,
    RootMismatch,
    ChainInvalid,
    SignatureInvalid,
}

impl EnvelopeCode {
    pub fn code(self) -> &'static str {
        match self {
            Self::Malformed => "ATT_MALFORMED",
            Self::RootMismatch => "ATT_ROOT_MISMATCH",
            Self::ChainInvalid => "ATT_CHAIN_INVALID",
            Self::SignatureInvalid => "ATT_SIGNATURE_INVALID",
        }
    }
}

/// A platform verifier module (V1–V5). One per platform, behind this interface.
pub trait AttestationVerifier {
    fn platform(&self) -> &'static str;
    fn verify_envelope(&self, doc: &[u8], trust_root_der: &[u8]) -> Result<Envelope, EnvelopeCode>;
}
