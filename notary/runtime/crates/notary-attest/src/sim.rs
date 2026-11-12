//! Simulator platform: verifier module and backend client.
//!
//! The simulator emits the **same** document format as AWS (same encoding and signature scheme), signed by a test
//! root; it differs only in the root and in `platform` (`ATT_PLATFORM_NOT_ALLOWED` unless enabled).
//! So its verifier module calls the AWS parser (G5: no format parsing here), and its backend is a
//! client of the fake enclave service in `notary/sim` (framing: 4-byte big-endian length + JSON, as
//! notary_runtime.md §8), so the runtime binary never contains the test CA key (Q13).
use crate::{aws, AttestError, AttestationBackend, AttestationVerifier, Envelope, EnvelopeCode};
use notary_types::{b64u, jcs};
use serde_json::{json, Value};
use std::io::{Read, Write};

pub struct SimVerifier;

impl AttestationVerifier for SimVerifier {
    fn platform(&self) -> &'static str {
        "simulator"
    }
    fn verify_envelope(&self, doc: &[u8], trust_root_der: &[u8]) -> Result<Envelope, EnvelopeCode> {
        aws::verify_envelope(doc, trust_root_der)
    }
}

/// Where the fake enclave service listens.
#[derive(Debug, Clone)]
pub enum SimAddr {
    #[cfg(unix)]
    Unix(std::path::PathBuf),
    Tcp(String),
}

pub fn write_frame(w: &mut impl Write, v: &Value) -> std::io::Result<()> {
    let bytes = jcs::canonical(v).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
    w.write_all(&(bytes.len() as u32).to_be_bytes())?;
    w.write_all(&bytes)?;
    w.flush()
}

pub fn read_frame(r: &mut impl Read) -> std::io::Result<Value> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len)?;
    let len = u32::from_be_bytes(len) as usize;
    if len > 16 * 1024 * 1024 {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    serde_json::from_slice(&buf).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

/// `SimulatorBackend`: a client of the fake enclave service.
pub struct SimulatorBackend {
    pub addr: SimAddr,
}

impl SimulatorBackend {
    pub fn new(addr: SimAddr) -> Self {
        Self { addr }
    }

    fn call(&self, req: &Value) -> Result<Value, AttestError> {
        let io = |e: std::io::Error| AttestError(e.to_string());
        let resp = match &self.addr {
            #[cfg(unix)]
            SimAddr::Unix(p) => {
                let mut s = std::os::unix::net::UnixStream::connect(p).map_err(io)?;
                write_frame(&mut s, req).map_err(io)?;
                read_frame(&mut s).map_err(io)?
            }
            SimAddr::Tcp(a) => {
                let mut s = std::net::TcpStream::connect(a).map_err(io)?;
                write_frame(&mut s, req).map_err(io)?;
                read_frame(&mut s).map_err(io)?
            }
        };
        if resp["ok"] == json!(true) { Ok(resp) } else { Err(AttestError(resp["error"].as_str().unwrap_or("simulator error").to_string())) }
    }

    /// The simulated attested clock (milliseconds), used by close logic (assumption T9) in place of `/dev/svc` time.
    pub fn attested_time_ms(&self) -> Result<u64, AttestError> {
        let r = self.call(&json!({ "kind": "time" }))?;
        r["ms"].as_u64().ok_or_else(|| AttestError("bad time reply".into()))
    }
}

impl AttestationBackend for SimulatorBackend {
    fn attest(&self, user_data: [u8; 181], public_key: Option<[u8; 32]>, nonce: [u8; 32]) -> Result<Vec<u8>, AttestError> {
        let mut req = json!({ "kind": "attest", "user_data": b64u::encode(&user_data), "nonce": b64u::encode(&nonce) });
        if let Some(pk) = public_key {
            req["public_key"] = json!(b64u::encode(&pk));
        }
        let r = self.call(&req)?;
        b64u::decode(r["document"].as_str().ok_or_else(|| AttestError("no document".into()))?).map_err(|e| AttestError(e.to_string()))
    }
    fn platform(&self) -> &'static str {
        "simulator"
    }
}
