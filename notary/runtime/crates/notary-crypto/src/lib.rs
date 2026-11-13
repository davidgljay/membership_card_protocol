//! notary-crypto — the runtime's cryptography (notary_runtime.md §4, §15).
//!
//! - **Secrets** live in `SecretBytes`: locked into memory (`mlock`) where the OS allows it, and zeroized on drop.
//! - **ML-DSA-44** (FIPS 204): `K_id`, `K_inst`, host receipts. Pure, empty context, deterministic signing; keys come
//!   from a 32-byte seed. Interop with `@noble/post-quantum` is proven in `tests/mldsa_interop.rs`.
//! - **X-Wing draft-06 HPKE** (`hpke` 0.15.1 + `x-wing` 0.1.1, never `rxwing`): job and handoff keys are raw 32-byte
//!   secrets generated here; `derive_keypair` is never called (erratum E8). Base mode, HKDF-SHA256, ChaCha20-Poly1305.
//! - **Receipts** (§24, erratum E7): ChaCha20-Poly1305 under the 32-byte `Export("card-notary-receipt-v1")`,
//!   12-byte all-zero nonce (the key is single-use per HPKE context), aad = RFC 8785 `{input_hash, job_hash, type}`.
//! - **secp256r1** (`K_chain`): signs 32-byte digests as the ECDSA message hash (erratum E12, option A).
//! - SHA-256, SHA3-256, keccak256, HKDF-SHA256.
use hpke::{
    aead::ChaCha20Poly1305, kdf::HkdfSha256, kem::XWing, Deserializable, Kem as KemTrait, OpModeR, OpModeS, Serializable,
};
use ml_dsa::{MlDsa44, Signature, SigningKey, VerifyingKey};
use notary_types::{b64u, jcs};
use serde_json::json;
use std::convert::Infallible;
use zeroize::Zeroize;

pub const KEM_ID: &str = "x-wing-draft-06";
pub const RECEIPT_EXPORT_CONTEXT: &[u8] = b"card-notary-receipt-v1";
pub const MLDSA44_PUBLIC_KEY_LEN: usize = 1312;
pub const MLDSA44_SIGNATURE_LEN: usize = 2420;
pub const XWING_PUBLIC_KEY_LEN: usize = 1216;
pub const XWING_ENC_LEN: usize = 1120;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CryptoError(pub &'static str);

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for CryptoError {}

// ---------------------------------------------------------------------------------------------------------------
// Secret buffers (§15)

/// A heap buffer for secret material: `mlock`ed while alive (best effort: `mlock` can be refused by rlimits outside
/// the enclave image, which `locked()` reports), zeroized and unlocked on drop. Never `Clone`, never `Debug`-printed.
pub struct SecretBytes {
    buf: Box<[u8]>,
    locked: bool,
}

impl SecretBytes {
    pub fn zeroed(len: usize) -> Self {
        let mut buf = vec![0u8; len].into_boxed_slice();
        // SAFETY: the pointer and length describe `buf`, which lives as long as `self`.
        let locked = len > 0 && unsafe { memsec::mlock(buf.as_mut_ptr(), buf.len()) };
        Self { buf, locked }
    }

    /// Takes ownership of `v`, copying it into a locked buffer and zeroizing the original.
    pub fn from_vec(mut v: Vec<u8>) -> Self {
        let mut s = Self::zeroed(v.len());
        s.buf.copy_from_slice(&v);
        v.zeroize();
        s
    }

    pub fn random(len: usize) -> Self {
        let mut s = Self::zeroed(len);
        fill_random(&mut s.buf);
        s
    }

    pub fn expose(&self) -> &[u8] {
        &self.buf
    }
    pub fn expose_mut(&mut self) -> &mut [u8] {
        &mut self.buf
    }
    pub fn len(&self) -> usize {
        self.buf.len()
    }
    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }
    /// Whether `mlock` succeeded.
    pub fn locked(&self) -> bool {
        self.locked
    }
}

impl Drop for SecretBytes {
    fn drop(&mut self) {
        self.buf.zeroize();
        if self.locked {
            // SAFETY: same buffer that was locked in `zeroed`.
            unsafe { memsec::munlock(self.buf.as_mut_ptr(), self.buf.len()) };
        }
    }
}

impl std::fmt::Debug for SecretBytes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SecretBytes({} bytes, redacted)", self.buf.len())
    }
}

/// Randomness from the kernel RNG (inside the enclave, seeded from the platform's security module at boot: runtime §4).
pub fn fill_random(dst: &mut [u8]) {
    getrandom::fill(dst).expect("kernel RNG unavailable");
}

pub fn random_array<const N: usize>() -> [u8; N] {
    let mut a = [0u8; N];
    fill_random(&mut a);
    a
}

/// `rand_core` 0.10 adapter over the kernel RNG, for the HPKE sender.
struct KernelRng;
impl rand_core::TryRng for KernelRng {
    type Error = Infallible;
    fn try_next_u32(&mut self) -> Result<u32, Infallible> {
        Ok(u32::from_le_bytes(random_array()))
    }
    fn try_next_u64(&mut self) -> Result<u64, Infallible> {
        Ok(u64::from_le_bytes(random_array()))
    }
    fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Infallible> {
        fill_random(dst);
        Ok(())
    }
}
impl rand_core::TryCryptoRng for KernelRng {}

// ---------------------------------------------------------------------------------------------------------------
// Hashes

pub fn sha256(data: &[u8]) -> [u8; 32] {
    use sha2::Digest;
    sha2::Sha256::digest(data).into()
}

pub fn sha3_256(data: &[u8]) -> [u8; 32] {
    use sha3::Digest;
    sha3::Sha3_256::digest(data).into()
}

pub fn keccak256(data: &[u8]) -> [u8; 32] {
    use sha3::Digest;
    sha3::Keccak256::digest(data).into()
}

/// HKDF-SHA256 (RFC 5869).
pub fn hkdf_sha256(ikm: &[u8], salt: &[u8], info: &[u8], out: &mut [u8]) -> Result<(), CryptoError> {
    hkdf::Hkdf::<sha2_11::Sha256>::new(Some(salt), ikm).expand(info, out).map_err(|_| CryptoError("HKDF output too long"))
}

// ---------------------------------------------------------------------------------------------------------------
// ML-DSA-44

/// An ML-DSA-44 signing key held as its 32-byte seed (FIPS 204 key generation from ξ).
pub struct MlDsaKey {
    seed: SecretBytes,
    sk: SigningKey<MlDsa44>,
    public: Vec<u8>,
}

impl MlDsaKey {
    pub fn generate() -> Self {
        Self::from_seed(SecretBytes::random(32)).expect("32-byte seed")
    }

    pub fn from_seed(seed: SecretBytes) -> Result<Self, CryptoError> {
        let arr: [u8; 32] = seed.expose().try_into().map_err(|_| CryptoError("ML-DSA seed must be 32 bytes"))?;
        let sk = SigningKey::<MlDsa44>::from_seed(&arr.into());
        let public = ml_dsa::signature::Keypair::verifying_key(&sk).encode().to_vec();
        Ok(Self { seed, sk, public })
    }

    pub fn public_key(&self) -> &[u8] {
        &self.public
    }

    /// The 32-byte seed, for attested handoff only (invariant I1).
    pub fn seed(&self) -> &SecretBytes {
        &self.seed
    }

    /// Signs `msg` (pure ML-DSA, empty context, deterministic).
    pub fn sign(&self, msg: &[u8]) -> Vec<u8> {
        self.sk.expanded_key().sign_deterministic(msg, b"").expect("ML-DSA signing").encode().to_vec()
    }

    /// A `SignatureEntry` over the RFC 8785 bytes of `obj` without `field` (notary signing convention).
    pub fn sign_object(&self, obj: &serde_json::Value, field: &str) -> Result<serde_json::Value, CryptoError> {
        let bytes = jcs::canonical(&jcs::without_fields(obj, &[field])).map_err(|_| CryptoError("object is not notary JSON"))?;
        Ok(json!({ "public_key": b64u::encode(&self.public), "signature": b64u::encode(&self.sign(&bytes)) }))
    }
}

pub fn mldsa_verify(public_key: &[u8], msg: &[u8], sig: &[u8]) -> bool {
    let Ok(pk) = public_key.try_into() else { return false };
    let vk = VerifyingKey::<MlDsa44>::decode(&pk);
    let Ok(sig) = sig.try_into() else { return false };
    let Some(sig) = Signature::<MlDsa44>::decode(&sig) else { return false };
    vk.verify_with_context(msg, b"", &sig)
}

/// Verifies a `SignatureEntry` on `obj` (field `field`) against `expected_key`.
pub fn verify_object(obj: &serde_json::Value, field: &str, expected_key: &[u8]) -> bool {
    let Some(entry) = obj.get(field) else { return false };
    let (Some(pk), Some(sig)) = (entry["public_key"].as_str(), entry["signature"].as_str()) else { return false };
    let (Ok(pk), Ok(sig)) = (b64u::decode(pk), b64u::decode(sig)) else { return false };
    if pk != expected_key {
        return false;
    }
    let Ok(bytes) = jcs::canonical(&jcs::without_fields(obj, &[field])) else { return false };
    mldsa_verify(&pk, &bytes, &sig)
}

// ---------------------------------------------------------------------------------------------------------------
// X-Wing draft-06 HPKE

type Kem = XWing;
type Aead = ChaCha20Poly1305;
type Kdf = HkdfSha256;

/// An X-Wing key pair (`K_job,e`, ephemeral handoff keys). The private key is the raw 32-byte secret.
pub struct XWingKey {
    secret: SecretBytes,
    public: Vec<u8>,
}

pub struct Opened {
    pub plaintext: SecretBytes,
    /// `Export("card-notary-receipt-v1", 32)` of the receiving context.
    pub receipt_key: SecretBytes,
}

impl XWingKey {
    pub fn generate() -> Self {
        Self::from_secret(SecretBytes::random(32)).expect("32-byte secret")
    }

    pub fn from_secret(secret: SecretBytes) -> Result<Self, CryptoError> {
        let sk = <Kem as KemTrait>::PrivateKey::from_bytes(secret.expose()).map_err(|_| CryptoError("bad X-Wing secret"))?;
        let public = Kem::sk_to_pk(&sk).to_bytes().to_vec();
        Ok(Self { secret, public })
    }

    pub fn public_key(&self) -> &[u8] {
        &self.public
    }

    /// The raw secret, for attested handoff only (invariant I1).
    pub fn secret(&self) -> &SecretBytes {
        &self.secret
    }

    /// Opens a sealed message and exports the receipt key from the same context.
    pub fn open(&self, enc: &[u8], ct: &[u8], info: &[u8], aad: &[u8]) -> Result<Opened, CryptoError> {
        let sk = <Kem as KemTrait>::PrivateKey::from_bytes(self.secret.expose()).map_err(|_| CryptoError("bad X-Wing secret"))?;
        let enc = <Kem as KemTrait>::EncappedKey::from_bytes(enc).map_err(|_| CryptoError("bad encapsulated key"))?;
        let mut ctx = hpke::setup_receiver::<Aead, Kdf, Kem>(&OpModeR::Base, &sk, &enc, info).map_err(|_| CryptoError("HPKE setup failed"))?;
        let plaintext = SecretBytes::from_vec(ctx.open(ct, aad).map_err(|_| CryptoError("HPKE open failed"))?);
        let mut receipt_key = SecretBytes::zeroed(32);
        ctx.export(RECEIPT_EXPORT_CONTEXT, receipt_key.expose_mut()).map_err(|_| CryptoError("HPKE export failed"))?;
        Ok(Opened { plaintext, receipt_key })
    }
}

pub struct Sealed {
    pub enc: Vec<u8>,
    pub ct: Vec<u8>,
    pub receipt_key: SecretBytes,
}

/// Seals to an X-Wing public key (used by handoff, and by tests playing the wallet).
pub fn xwing_seal(public_key: &[u8], info: &[u8], aad: &[u8], plaintext: &[u8]) -> Result<Sealed, CryptoError> {
    let pk = <Kem as KemTrait>::PublicKey::from_bytes(public_key).map_err(|_| CryptoError("bad X-Wing public key"))?;
    let (enc, mut ctx) =
        hpke::setup_sender_with_rng::<Aead, Kdf, Kem>(&OpModeS::Base, &pk, info, &mut KernelRng).map_err(|_| CryptoError("HPKE setup failed"))?;
    let ct = ctx.seal(plaintext, aad).map_err(|_| CryptoError("HPKE seal failed"))?;
    let mut receipt_key = SecretBytes::zeroed(32);
    ctx.export(RECEIPT_EXPORT_CONTEXT, receipt_key.expose_mut()).map_err(|_| CryptoError("HPKE export failed"))?;
    Ok(Sealed { enc: enc.to_bytes().to_vec(), ct, receipt_key })
}

/// `info` and `aad` of a `SealedInput` (§24), byte for byte as the wallet builds them.
pub fn sealed_input_info_aad(job_hash: &[u8; 32], epoch: u64) -> (Vec<u8>, Vec<u8>) {
    let mut info = b"card-notary-input-v1".to_vec();
    info.push(0);
    info.extend_from_slice(job_hash);
    info.extend_from_slice(&epoch.to_be_bytes());
    info.extend_from_slice(KEM_ID.as_bytes());
    let aad = jcs::canonical(&json!({ "epoch": epoch, "job_hash": b64u::encode(job_hash), "kem": KEM_ID, "type": "notary.sealed_input.v1" }))
        .expect("canonical aad");
    (info, aad)
}

// ---------------------------------------------------------------------------------------------------------------
// Sealed validation receipts (§24, E7)

fn receipt_aad(input_hash_b64: &str, job_hash_b64: &str) -> Vec<u8> {
    jcs::canonical(&json!({ "input_hash": input_hash_b64, "job_hash": job_hash_b64, "type": "notary.validation_receipt.sealed.v1" }))
        .expect("canonical aad")
}

pub fn seal_receipt(receipt_key: &SecretBytes, input_hash_b64: &str, job_hash_b64: &str, receipt_json: &[u8]) -> Result<Vec<u8>, CryptoError> {
    use chacha20poly1305::{aead::{Aead as _, KeyInit, Payload}, ChaCha20Poly1305 as C};
    let c = C::new_from_slice(receipt_key.expose()).map_err(|_| CryptoError("receipt key must be 32 bytes"))?;
    c.encrypt(&[0u8; 12].into(), Payload { msg: receipt_json, aad: &receipt_aad(input_hash_b64, job_hash_b64) })
        .map_err(|_| CryptoError("receipt seal failed"))
}

pub fn open_receipt(receipt_key: &SecretBytes, input_hash_b64: &str, job_hash_b64: &str, sealed: &[u8]) -> Result<Vec<u8>, CryptoError> {
    use chacha20poly1305::{aead::{Aead as _, KeyInit, Payload}, ChaCha20Poly1305 as C};
    let c = C::new_from_slice(receipt_key.expose()).map_err(|_| CryptoError("receipt key must be 32 bytes"))?;
    c.decrypt(&[0u8; 12].into(), Payload { msg: sealed, aad: &receipt_aad(input_hash_b64, job_hash_b64) })
        .map_err(|_| CryptoError("receipt open failed"))
}

// ---------------------------------------------------------------------------------------------------------------
// secp256r1 (`K_chain`)

pub struct ChainKey {
    sk: p256::ecdsa::SigningKey,
}

impl ChainKey {
    pub fn generate() -> Self {
        loop {
            let s = SecretBytes::random(32);
            if let Ok(sk) = p256::ecdsa::SigningKey::from_slice(s.expose()) {
                return Self { sk };
            }
        }
    }

    pub fn from_secret(secret: &SecretBytes) -> Result<Self, CryptoError> {
        p256::ecdsa::SigningKey::from_slice(secret.expose()).map(|sk| Self { sk }).map_err(|_| CryptoError("bad secp256r1 secret"))
    }

    /// The 32-byte scalar, for attested handoff only.
    pub fn secret(&self) -> SecretBytes {
        SecretBytes::from_vec(self.sk.to_bytes().to_vec())
    }

    /// Uncompressed public key without the 0x04 prefix: 64 bytes `x || y` (the registry's encoding).
    pub fn public_key_xy(&self) -> Vec<u8> {
        let pt = self.sk.verifying_key().to_sec1_point(false);
        pt.as_bytes()[1..].to_vec()
    }

    /// Signs a 32-byte digest as the ECDSA message hash (E12 option A). Returns raw `r || s` (64 bytes), low-s.
    pub fn sign_digest(&self, digest: &[u8; 32]) -> Result<Vec<u8>, CryptoError> {
        use p256::ecdsa::signature::hazmat::PrehashSigner;
        let sig: p256::ecdsa::Signature = self.sk.sign_prehash(digest).map_err(|_| CryptoError("ECDSA signing failed"))?;
        Ok(sig.normalize_s().to_bytes().to_vec())
    }
}

/// Verifies a raw `r || s` ECDSA secp256r1 signature over a 32-byte digest used as the message hash.
pub fn p256_verify_digest(public_key_xy: &[u8], digest: &[u8; 32], sig: &[u8]) -> bool {
    use p256::ecdsa::signature::hazmat::PrehashVerifier;
    if public_key_xy.len() != 64 {
        return false;
    }
    let mut sec1 = vec![0x04];
    sec1.extend_from_slice(public_key_xy);
    let Ok(vk) = p256::ecdsa::VerifyingKey::from_sec1_bytes(&sec1) else { return false };
    let Ok(sig) = p256::ecdsa::Signature::from_slice(sig) else { return false };
    vk.verify_prehash(digest, &sig).is_ok()
}
