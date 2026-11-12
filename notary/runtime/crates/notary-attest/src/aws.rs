//! AWS Nitro Enclaves attestation documents: parse and verify (V1–V5), build (test PKI only), NSM backend.
//!
//! Implements: notary_lifecycle.md A.1 steps 1–5; notary_runtime.md §5.
//! G5: this is the only Rust module that parses or produces the AWS format (COSE_Sign1, ES384, CBOR).
//!
//! Document layout (AWS Nitro Enclaves attestation document):
//!   COSE_Sign1 = Tag(18, [protected: bstr({1: -35}), unprotected: {}, payload: bstr, signature: bstr(96)])
//!   payload = { module_id, digest: "SHA384", timestamp (ms), pcrs, certificate, cabundle, public_key?, user_data?, nonce? }
//!   cabundle = [root, intermediate…]; the leaf is `certificate`.
//!
//! Chain rules checked (V4), each with a test: signature at every link; every certificate valid at the
//! document's timestamp; issuer name = parent's subject name; issuers have `basicConstraints` cA=true,
//! honour `pathLenConstraint`, and (if `keyUsage` is present) allow `keyCertSign`; the leaf is not a CA;
//! unknown critical extensions are rejected; ECDSA P-384 with SHA-384 only.
//! Parser strictness: the document must be one CBOR item with no trailing bytes, duplicate map keys are
//! rejected, and sizes are bounded. (ciborium accepts indefinite-length items; the TypeScript decoder
//! rejects them. Disagreement on such documents is conservative on the TypeScript side.)
use crate::{AttestationVerifier, Envelope, EnvelopeCode};
use ciborium::value::Value;
use der::{Decode, Encode};
use p384::ecdsa::{signature::Verifier, DerSignature, Signature, VerifyingKey};
use std::collections::BTreeMap;
use x509_cert::{ext::pkix::{BasicConstraints, KeyUsage, KeyUsages}, Certificate};

/// COSE algorithm identifier for ES384.
const COSE_ES384: i64 = -35;
const OID_ECDSA_SHA384: &str = "1.2.840.10045.4.3.3";
const OID_BASIC_CONSTRAINTS: &str = "2.5.29.19";
const OID_KEY_USAGE: &str = "2.5.29.15";
const KNOWN_CRITICAL: [&str; 4] = [OID_BASIC_CONSTRAINTS, OID_KEY_USAGE, "2.5.29.37", "2.5.29.14"];
const MAX_DOC: usize = 64 * 1024;
const MAX_FIELD: usize = 1024;

/// The production verifier module.
pub struct AwsVerifier;

impl AttestationVerifier for AwsVerifier {
    fn platform(&self) -> &'static str {
        "aws-nitro-enclaves"
    }
    fn verify_envelope(&self, doc: &[u8], trust_root_der: &[u8]) -> Result<Envelope, EnvelopeCode> {
        verify_envelope(doc, trust_root_der)
    }
}

type R<T> = Result<T, EnvelopeCode>;
use EnvelopeCode::{ChainInvalid, Malformed, RootMismatch, SignatureInvalid};

fn decode_one(bytes: &[u8]) -> R<Value> {
    let mut rd = bytes;
    let v: Value = ciborium::from_reader(&mut rd).map_err(|_| Malformed)?;
    if !rd.is_empty() {
        return Err(Malformed);
    }
    Ok(v)
}

fn bstr(v: &Value, max: usize) -> R<&Vec<u8>> {
    match v {
        Value::Bytes(b) if !b.is_empty() && b.len() <= max => Ok(b),
        _ => Err(Malformed),
    }
}

fn map_get<'a>(m: &'a [(Value, Value)], key: &str) -> R<Option<&'a Value>> {
    let mut found = None;
    for (k, v) in m {
        if let Value::Text(t) = k {
            if t == key {
                if found.is_some() {
                    return Err(Malformed); // duplicate key
                }
                found = Some(v);
            }
        }
    }
    Ok(found)
}

fn opt_bstr(m: &[(Value, Value)], key: &str, max: usize) -> R<Option<Vec<u8>>> {
    match map_get(m, key)? {
        None | Some(Value::Null) => Ok(None),
        Some(v) => Ok(Some(bstr(v, max)?.clone())),
    }
}

fn no_dup_keys(m: &[(Value, Value)]) -> R<()> {
    for (i, (k, _)) in m.iter().enumerate() {
        if m[..i].iter().any(|(k2, _)| k2 == k) {
            return Err(Malformed);
        }
    }
    Ok(())
}

/// V1–V5. `trust_root_der` is the pinned root certificate (DER).
pub fn verify_envelope(doc: &[u8], trust_root_der: &[u8]) -> R<Envelope> {
    if doc.len() > MAX_DOC {
        return Err(Malformed);
    }
    // V1: COSE_Sign1 with ES384
    let Value::Tag(18, inner) = decode_one(doc)? else { return Err(Malformed) };
    let Value::Array(parts) = *inner else { return Err(Malformed) };
    let [protected, unprotected, payload, signature] = parts.as_slice() else { return Err(Malformed) };
    let protected_bytes = bstr(protected, 64)?;
    let Value::Map(unprot) = unprotected else { return Err(Malformed) };
    if !unprot.is_empty() {
        return Err(Malformed);
    }
    let Value::Map(prot) = decode_one(protected_bytes)? else { return Err(Malformed) };
    no_dup_keys(&prot)?;
    let alg = prot.iter().find(|(k, _)| *k == Value::Integer(1.into())).map(|(_, v)| v);
    match alg {
        Some(Value::Integer(i)) if i128::from(*i) == COSE_ES384 as i128 => {}
        _ => return Err(Malformed),
    }
    let payload_bytes = bstr(payload, MAX_DOC)?;
    let signature_bytes = bstr(signature, 96)?;
    if signature_bytes.len() != 96 {
        return Err(Malformed);
    }

    // V2: payload fields present, digest == SHA384
    let Value::Map(p) = decode_one(payload_bytes)? else { return Err(Malformed) };
    no_dup_keys(&p)?;
    match map_get(&p, "module_id")? {
        Some(Value::Text(t)) if !t.is_empty() => {}
        _ => return Err(Malformed),
    }
    match map_get(&p, "digest")? {
        Some(Value::Text(t)) if t == "SHA384" => {}
        _ => return Err(Malformed),
    }
    let timestamp_ms: u64 = match map_get(&p, "timestamp")? {
        Some(Value::Integer(i)) => u64::try_from(i128::from(*i)).map_err(|_| Malformed)?,
        _ => return Err(Malformed),
    };
    let mut pcrs = BTreeMap::new();
    match map_get(&p, "pcrs")? {
        Some(Value::Map(m)) if !m.is_empty() && m.len() <= 32 => {
            no_dup_keys(m)?;
            for (k, v) in m {
                let Value::Integer(i) = k else { return Err(Malformed) };
                let idx = u32::try_from(i128::from(*i)).map_err(|_| Malformed)?;
                let b = bstr(v, 64)?;
                if idx >= 32 || ![32, 48, 64].contains(&b.len()) {
                    return Err(Malformed);
                }
                pcrs.insert(idx, b.clone());
            }
        }
        _ => return Err(Malformed),
    }
    let Some(measurement) = pcrs.get(&0).cloned() else { return Err(Malformed) };
    let certificate = match map_get(&p, "certificate")? {
        Some(v) => bstr(v, MAX_FIELD * 4)?.clone(),
        None => return Err(Malformed),
    };
    let cabundle: Vec<Vec<u8>> = match map_get(&p, "cabundle")? {
        Some(Value::Array(a)) if !a.is_empty() && a.len() <= 8 => a.iter().map(|x| bstr(x, MAX_FIELD * 4).cloned()).collect::<R<_>>()?,
        _ => return Err(Malformed),
    };
    let public_key = opt_bstr(&p, "public_key", MAX_FIELD)?;
    let user_data = opt_bstr(&p, "user_data", MAX_FIELD)?.unwrap_or_default();
    let nonce = opt_bstr(&p, "nonce", MAX_FIELD)?;

    // V3: the first CA bundle entry is the pinned root, byte for byte
    if cabundle[0].as_slice() != trust_root_der {
        return Err(RootMismatch);
    }

    // V4: chain root → … → leaf, every certificate valid at the document's timestamp
    let mut chain: Vec<Certificate> = Vec::new();
    for der_bytes in cabundle.iter().chain(std::iter::once(&certificate)) {
        chain.push(Certificate::from_der(der_bytes).map_err(|_| ChainInvalid)?);
    }
    verify_chain(&chain, timestamp_ms)?;

    // V5: COSE signature with the leaf key
    let leaf = chain.last().unwrap();
    let key = verifying_key(leaf)?;
    let mut sig_structure = Vec::new();
    ciborium::into_writer(
        &Value::Array(vec![
            Value::Text("Signature1".into()),
            Value::Bytes(protected_bytes.clone()),
            Value::Bytes(vec![]),
            Value::Bytes(payload_bytes.clone()),
        ]),
        &mut sig_structure,
    )
    .map_err(|_| Malformed)?;
    let sig = Signature::from_slice(signature_bytes).map_err(|_| SignatureInvalid)?;
    key.verify(&sig_structure, &sig).map_err(|_| SignatureInvalid)?;

    Ok(Envelope { measurement, pcrs, timestamp_ms, user_data, nonce, public_key })
}

fn verifying_key(cert: &Certificate) -> R<VerifyingKey> {
    let spki = &cert.tbs_certificate().subject_public_key_info();
    if spki.algorithm.oid.to_string() != "1.2.840.10045.2.1" {
        return Err(ChainInvalid);
    }
    let bytes = spki.subject_public_key.as_bytes().ok_or(ChainInvalid)?;
    VerifyingKey::from_sec1_bytes(bytes).map_err(|_| ChainInvalid)
}

fn time_ms(t: &x509_cert::time::Time) -> u64 {
    t.to_unix_duration().as_millis() as u64
}

fn verify_chain(chain: &[Certificate], at_ms: u64) -> R<()> {
    let n = chain.len();
    for (i, cert) in chain.iter().enumerate() {
        let tbs = cert.tbs_certificate();
        // validity at the document's timestamp
        if at_ms < time_ms(&tbs.validity().not_before) || at_ms > time_ms(&tbs.validity().not_after) {
            return Err(ChainInvalid);
        }
        if cert.signature_algorithm().oid.to_string() != OID_ECDSA_SHA384 || tbs.signature().oid != cert.signature_algorithm().oid {
            return Err(ChainInvalid);
        }
        // extensions: unknown critical ones are rejected; basicConstraints and keyUsage are read
        let (mut ca, mut path_len, mut key_cert_sign): (bool, Option<u8>, Option<bool>) = (false, None, None);
        for ext in tbs.extensions().into_iter().flatten() {
            let oid = ext.extn_id.to_string();
            if oid == OID_BASIC_CONSTRAINTS {
                let bc = BasicConstraints::from_der(ext.extn_value.as_bytes()).map_err(|_| ChainInvalid)?;
                ca = bc.ca;
                path_len = bc.path_len_constraint;
            } else if oid == OID_KEY_USAGE {
                let ku = KeyUsage::from_der(ext.extn_value.as_bytes()).map_err(|_| ChainInvalid)?;
                key_cert_sign = Some(ku.0.contains(KeyUsages::KeyCertSign));
            } else if ext.critical && !KNOWN_CRITICAL.contains(&oid.as_str()) {
                return Err(ChainInvalid);
            }
        }
        let is_leaf = i == n - 1;
        if is_leaf {
            if ca {
                return Err(ChainInvalid);
            }
        } else {
            // an issuer: must be a CA, allow keyCertSign if keyUsage is present, and honour pathLen
            let below = (n - 2 - i) as u32; // intermediate certificates between this one and the leaf
            if !ca || key_cert_sign == Some(false) || path_len.is_some_and(|p| u32::from(p) < below) {
                return Err(ChainInvalid);
            }
        }
        // signature by the parent (the root signs itself)
        let parent = if i == 0 { cert } else { &chain[i - 1] };
        if tbs.issuer() != parent.tbs_certificate().subject() {
            return Err(ChainInvalid);
        }
        let tbs_der = tbs.to_der().map_err(|_| ChainInvalid)?;
        let sig = DerSignature::try_from(cert.signature().as_bytes().ok_or(ChainInvalid)?).map_err(|_| ChainInvalid)?;
        verifying_key(parent)?.verify(&tbs_der, &sig).map_err(|_| ChainInvalid)?;
    }
    Ok(())
}

/// Test PKI and document builder. Compiled only with the `test-pki` feature (used by notary/sim and tests).
/// Produces documents in the AWS format, signed by a test root instead of the AWS root (G5: part of `aws`).
#[cfg(feature = "test-pki")]
pub mod build {
    use super::*;
    use der::asn1::OctetString;
    use p384::ecdsa::{signature::Signer, DerSignature, SigningKey};
    use p384::pkcs8::EncodePublicKey;
    use sha2::{Digest, Sha384};
    use std::{str::FromStr, time::{Duration, SystemTime}};
    use x509_cert::{
        builder::{profile::BuilderProfile, Builder, CertificateBuilder},
        ext::Extension,
        name::Name,
        serial_number::SerialNumber,
        spki::SubjectPublicKeyInfoOwned,
        time::{Time, Validity},
    };

    /// Deterministic P-384 key from a seed (test use only).
    pub fn key_from_seed(seed: &[u8]) -> SigningKey {
        for counter in 0u32.. {
            let mut h = Sha384::new();
            h.update(b"card-notary-test-pki");
            h.update(seed);
            h.update(counter.to_be_bytes());
            if let Ok(k) = SigningKey::from_slice(&h.finalize()) {
                return k;
            }
        }
        unreachable!()
    }

    /// How a test certificate is shaped; the defaults describe a correct certificate.
    #[derive(Clone, Debug)]
    pub struct CertSpec {
        pub ca: bool,
        pub path_len: Option<u8>,
        /// `Some(false)` makes a keyUsage extension without keyCertSign.
        pub key_cert_sign: Option<bool>,
        pub unknown_critical_extension: bool,
        pub not_before_s: u64,
        pub not_after_s: u64,
    }

    impl CertSpec {
        pub fn ca(not_before_s: u64, not_after_s: u64) -> Self {
            Self { ca: true, path_len: None, key_cert_sign: Some(true), unknown_critical_extension: false, not_before_s, not_after_s }
        }
        pub fn leaf(not_before_s: u64, not_after_s: u64) -> Self {
            Self { ca: false, path_len: None, key_cert_sign: None, unknown_critical_extension: false, not_before_s, not_after_s }
        }
    }

    struct TestProfile {
        subject: Name,
        issuer: Name,
        spec: CertSpec,
    }

    impl BuilderProfile for TestProfile {
        fn get_issuer(&self, _subject: &Name) -> Name {
            self.issuer.clone()
        }
        fn get_subject(&self) -> Name {
            self.subject.clone()
        }
        fn build_extensions(
            &self,
            _spk: spki::SubjectPublicKeyInfoRef<'_>,
            _issuer_spk: spki::SubjectPublicKeyInfoRef<'_>,
            _tbs: &x509_cert::certificate::TbsCertificate,
        ) -> x509_cert::builder::Result<Vec<Extension>> {
            let ext = |oid: &str, critical: bool, value: Vec<u8>| Extension {
                extn_id: der::asn1::ObjectIdentifier::new_unwrap(oid),
                critical,
                extn_value: OctetString::new(value).unwrap(),
            };
            let mut out = vec![ext(
                OID_BASIC_CONSTRAINTS,
                true,
                BasicConstraints { ca: self.spec.ca, path_len_constraint: self.spec.path_len }.to_der().unwrap(),
            )];
            if let Some(kcs) = self.spec.key_cert_sign {
                let flags = if kcs { KeyUsages::KeyCertSign | KeyUsages::CRLSign } else { KeyUsages::DigitalSignature.into() };
                out.push(ext(OID_KEY_USAGE, true, KeyUsage(flags).to_der().unwrap()));
            }
            if self.spec.unknown_critical_extension {
                out.push(ext("1.3.6.1.4.1.99999.1", true, vec![0x05, 0x00]));
            }
            Ok(out)
        }
    }

    fn name(cn: &str) -> Name {
        Name::from_str(&format!("CN={cn},O=Card Notary Test PKI")).unwrap()
    }

    fn time(secs: u64) -> Time {
        Time::try_from(SystemTime::UNIX_EPOCH + Duration::from_secs(secs)).unwrap()
    }

    /// Issues a certificate for `subject_key`, signed by `issuer_key`.
    pub fn issue(subject_cn: &str, subject_key: &SigningKey, issuer_cn: &str, issuer_key: &SigningKey, serial: u8, spec: CertSpec) -> Vec<u8> {
        let spki_der = subject_key.verifying_key().to_public_key_der().unwrap();
        let spki = SubjectPublicKeyInfoOwned::from_der(spki_der.as_bytes()).unwrap();
        let validity = Validity::new(time(spec.not_before_s), time(spec.not_after_s));
        let profile = TestProfile { subject: name(subject_cn), issuer: name(issuer_cn), spec };
        let builder = CertificateBuilder::new(profile, SerialNumber::new(&[serial]).unwrap(), validity, spki).unwrap();
        builder.build::<_, DerSignature>(issuer_key).unwrap().to_der().unwrap()
    }

    /// 2020-01-01 and 2049-01-01 (UTCTime ends in 2049).
    pub const T_2020: u64 = 1_577_836_800;
    pub const T_2049: u64 = 2_493_072_000;

    /// A three-level test PKI shaped like AWS's: root → intermediate → leaf signing key.
    pub struct Pki {
        pub root_der: Vec<u8>,
        pub intermediate_der: Vec<u8>,
        pub leaf_der: Vec<u8>,
        pub leaf_key: SigningKey,
        root_key: SigningKey,
        intermediate_key: SigningKey,
    }

    impl Pki {
        /// Correct PKI valid 2020–2049, deterministic from `seed`.
        pub fn new(seed: &str) -> Self {
            Self::with_specs(seed, CertSpec::ca(T_2020, T_2049), CertSpec::ca(T_2020, T_2049), CertSpec::leaf(T_2020, T_2049))
        }

        pub fn with_specs(seed: &str, root: CertSpec, intermediate: CertSpec, leaf: CertSpec) -> Self {
            let root_key = key_from_seed(format!("{seed}/root").as_bytes());
            let intermediate_key = key_from_seed(format!("{seed}/intermediate").as_bytes());
            let leaf_key = key_from_seed(format!("{seed}/leaf").as_bytes());
            let root_der = issue("test.nitro-enclaves", &root_key, "test.nitro-enclaves", &root_key, 1, root);
            let intermediate_der = issue("test.intermediate", &intermediate_key, "test.nitro-enclaves", &root_key, 2, intermediate);
            let leaf_der = issue("test.leaf", &leaf_key, "test.intermediate", &intermediate_key, 3, leaf);
            Self { root_der, intermediate_der, leaf_der, leaf_key, root_key, intermediate_key }
        }

        pub fn cabundle(&self) -> Vec<Vec<u8>> {
            vec![self.root_der.clone(), self.intermediate_der.clone()]
        }
        pub fn root_key(&self) -> &SigningKey {
            &self.root_key
        }
        pub fn intermediate_key(&self) -> &SigningKey {
            &self.intermediate_key
        }
    }

    /// The fields of a document, so that tests can build each malformed variant.
    #[derive(Clone, Debug)]
    pub struct DocFields {
        pub module_id: String,
        pub digest: String,
        pub timestamp_ms: u64,
        pub pcrs: BTreeMap<u32, Vec<u8>>,
        pub certificate: Vec<u8>,
        pub cabundle: Vec<Vec<u8>>,
        pub public_key: Option<Vec<u8>>,
        pub user_data: Option<Vec<u8>>,
        pub nonce: Option<Vec<u8>>,
    }

    impl DocFields {
        pub fn new(pki: &Pki, timestamp_ms: u64, pcrs: BTreeMap<u32, Vec<u8>>) -> Self {
            Self {
                module_id: "i-0123456789abcdef0-enc0123456789abcdef".into(), digest: "SHA384".into(), timestamp_ms, pcrs,
                certificate: pki.leaf_der.clone(), cabundle: pki.cabundle(), public_key: None, user_data: None, nonce: None,
            }
        }
    }

    /// PCR0–2 non-zero (production-like) or all zero (debug mode), plus PCR3/4/8 like a real enclave.
    pub fn pcrs(pcr0: u8, debug: bool) -> BTreeMap<u32, Vec<u8>> {
        let v = |n: u8| if debug { vec![0u8; 48] } else { vec![n; 48] };
        BTreeMap::from([(0, v(pcr0)), (1, v(pcr0.wrapping_add(1))), (2, v(pcr0.wrapping_add(2))), (3, vec![0x33; 48]), (4, vec![0x44; 48]), (8, vec![0u8; 48])])
    }

    fn cbor(v: &Value) -> Vec<u8> {
        let mut out = vec![];
        ciborium::into_writer(v, &mut out).unwrap();
        out
    }

    pub fn payload_bytes(f: &DocFields) -> Vec<u8> {
        let opt = |o: &Option<Vec<u8>>| o.as_ref().map_or(Value::Null, |b| Value::Bytes(b.clone()));
        cbor(&Value::Map(vec![
            (Value::Text("module_id".into()), Value::Text(f.module_id.clone())),
            (Value::Text("digest".into()), Value::Text(f.digest.clone())),
            (Value::Text("timestamp".into()), Value::Integer(f.timestamp_ms.into())),
            (Value::Text("pcrs".into()), Value::Map(f.pcrs.iter().map(|(k, v)| (Value::Integer((*k).into()), Value::Bytes(v.clone()))).collect())),
            (Value::Text("certificate".into()), Value::Bytes(f.certificate.clone())),
            (Value::Text("cabundle".into()), Value::Array(f.cabundle.iter().map(|c| Value::Bytes(c.clone())).collect())),
            (Value::Text("public_key".into()), opt(&f.public_key)),
            (Value::Text("user_data".into()), opt(&f.user_data)),
            (Value::Text("nonce".into()), opt(&f.nonce)),
        ]))
    }

    /// COSE_Sign1 over arbitrary payload bytes with an arbitrary protected header and signing key.
    pub fn cose_sign1(protected: Vec<u8>, payload: Vec<u8>, key: &SigningKey) -> Vec<u8> {
        let sig_structure = cbor(&Value::Array(vec![
            Value::Text("Signature1".into()), Value::Bytes(protected.clone()), Value::Bytes(vec![]), Value::Bytes(payload.clone()),
        ]));
        let sig: Signature = key.sign(&sig_structure);
        cose_wrap(protected, payload, sig.to_bytes().to_vec())
    }

    pub fn cose_wrap(protected: Vec<u8>, payload: Vec<u8>, signature: Vec<u8>) -> Vec<u8> {
        cbor(&Value::Tag(18, Box::new(Value::Array(vec![Value::Bytes(protected), Value::Map(vec![]), Value::Bytes(payload), Value::Bytes(signature)]))))
    }

    pub fn es384_protected() -> Vec<u8> {
        cbor(&Value::Map(vec![(Value::Integer(1.into()), Value::Integer((-35).into()))]))
    }

    /// A correctly signed document.
    pub fn build_document(f: &DocFields, leaf_key: &SigningKey) -> Vec<u8> {
        cose_sign1(es384_protected(), payload_bytes(f), leaf_key)
    }
}

/// The real NSM backend: requests attestation documents from `/dev/nsm`. Production only.
/// Written in step 5.2; **untested until Phase 8** (real hardware; CP9 checkpoints 2 and 3: the
/// NSM must accept 181-byte `user_data`, 32-byte `public_key` and 32-byte `nonce`, and the parent
/// instance must not be able to skew NSM time).
#[cfg(feature = "nsm")]
pub struct NsmBackend {
    fd: i32,
}

#[cfg(feature = "nsm")]
impl NsmBackend {
    /// Opens `/dev/nsm`. Fails outside an enclave.
    pub fn open() -> Result<Self, crate::AttestError> {
        let fd = aws_nitro_enclaves_nsm_api::driver::nsm_init();
        if fd < 0 {
            return Err(crate::AttestError("cannot open /dev/nsm".into()));
        }
        Ok(Self { fd })
    }
}

#[cfg(feature = "nsm")]
impl Drop for NsmBackend {
    fn drop(&mut self) {
        aws_nitro_enclaves_nsm_api::driver::nsm_exit(self.fd);
    }
}

#[cfg(feature = "nsm")]
impl crate::AttestationBackend for NsmBackend {
    fn attest(&self, user_data: [u8; 181], public_key: Option<[u8; 32]>, nonce: [u8; 32]) -> Result<Vec<u8>, crate::AttestError> {
        use aws_nitro_enclaves_nsm_api::api::{Request, Response};
        use serde_bytes::ByteBuf;
        let req = Request::Attestation {
            user_data: Some(ByteBuf::from(user_data.to_vec())),
            nonce: Some(ByteBuf::from(nonce.to_vec())),
            public_key: public_key.map(|k| ByteBuf::from(k.to_vec())),
        };
        match aws_nitro_enclaves_nsm_api::driver::nsm_process_request(self.fd, req) {
            Response::Attestation { document } => Ok(document),
            Response::Error(e) => Err(crate::AttestError(format!("NSM error: {e:?}"))),
            _ => Err(crate::AttestError("unexpected NSM response".into())),
        }
    }
    fn platform(&self) -> &'static str {
        "aws-nitro-enclaves"
    }
}

/// The AWS Nitro Enclaves root certificate (G1), DER. Fingerprint documented by AWS:
/// SHA-256 641A0321A3E244EFE456463195D606317ED7CDCC3C1756E09893F3C68F79BB5B.
pub const AWS_NITRO_ROOT_G1_DER: &[u8] = include_bytes!("../../../../deploy/aws/AWS_NitroEnclaves_Root-G1.der");

#[cfg(test)]
mod root_tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn embedded_root_matches_the_fingerprint_aws_documents() {
        let fp: String = Sha256::digest(AWS_NITRO_ROOT_G1_DER).iter().map(|b| format!("{b:02X}")).collect();
        assert_eq!(fp, "641A0321A3E244EFE456463195D606317ED7CDCC3C1756E09893F3C68F79BB5B");
        let cert = Certificate::from_der(AWS_NITRO_ROOT_G1_DER).unwrap();
        assert_eq!(cert.tbs_certificate().issuer(), cert.tbs_certificate().subject());
        assert_eq!(cert.signature_algorithm().oid.to_string(), OID_ECDSA_SHA384);
    }
}
