//! notary-sim — the enclave simulator.
//!
//! * **Test root CA:** a fixed, clearly labelled test PKI (`TestRoot`), deterministic from a seed so that
//!   committed fixtures are stable. Production configurations pin the real AWS root, so this root is never
//!   trusted there; documents also carry `platform: "simulator"` at the verifier, refused unless enabled.
//! * **Fake enclave service (`FakeEnclave`):** one socket per simulated enclave. `attest` returns a document in the
//!   AWS format signed by the test PKI, with configurable PCRs and debug flag; `time` returns the attested clock,
//!   which tests can set apart from chain time (close tests, assumption T9).
//! * The launcher that spawns `notary-runtime` processes as "enclaves" arrives with the runtime (step 5.3).
//!
//! Implements: plans/notary-code-plan.md §2.2; notary_runtime.md §5.
use notary_attest::{
    aws::build::{build_document, pcrs, DocFields, Pki},
    sim::{read_frame, write_frame, SimAddr},
};
use notary_types::b64u;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// The simulator's trust root seed. TEST ONLY.
pub const TEST_ROOT_SEED: &str = "card-notary-simulator-test-root-v1";

/// The simulator's PKI (root → intermediate → attestation signing key).
pub fn test_pki() -> Pki {
    Pki::new(TEST_ROOT_SEED)
}

/// The DER of the simulator's root certificate, for `Config.roots["simulator"]`.
pub fn test_root_der() -> Vec<u8> {
    test_pki().root_der
}

#[derive(Debug, Clone)]
pub struct EnclaveConfig {
    /// First byte repeated to make PCR0 (PCR1 and PCR2 derive from it).
    pub pcr0_seed: u8,
    pub debug: bool,
    /// `None` follows the real clock; `Some(ms)` pins the attested clock.
    pub clock_ms: Option<u64>,
}

impl Default for EnclaveConfig {
    fn default() -> Self {
        Self { pcr0_seed: 0x10, debug: false, clock_ms: None }
    }
}

/// PCR0 value that an `EnclaveConfig` with this seed reports (for building accepted-runtime lists).
pub fn pcr0_of(seed: u8) -> Vec<u8> {
    vec![seed; 48]
}

fn wall_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

/// A running fake enclave service. Dropping it does not stop the listener thread (it exits with the process).
pub struct FakeEnclave {
    pub addr: SimAddr,
    state: Arc<Mutex<EnclaveConfig>>,
}

impl FakeEnclave {
    #[cfg(unix)]
    pub fn start_unix(path: impl Into<std::path::PathBuf>, cfg: EnclaveConfig) -> std::io::Result<Self> {
        let path = path.into();
        let _ = std::fs::remove_file(&path);
        let listener = std::os::unix::net::UnixListener::bind(&path)?;
        let state = Arc::new(Mutex::new(cfg));
        let st = state.clone();
        let pki = Arc::new(test_pki());
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (st, pki) = (st.clone(), pki.clone());
                std::thread::spawn(move || serve(stream, &st, &pki));
            }
        });
        Ok(Self { addr: SimAddr::Unix(path), state })
    }

    pub fn start_tcp(bind: &str, cfg: EnclaveConfig) -> std::io::Result<Self> {
        let listener = std::net::TcpListener::bind(bind)?;
        let addr = listener.local_addr()?.to_string();
        let state = Arc::new(Mutex::new(cfg));
        let st = state.clone();
        let pki = Arc::new(test_pki());
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (st, pki) = (st.clone(), pki.clone());
                std::thread::spawn(move || serve(stream, &st, &pki));
            }
        });
        Ok(Self { addr: SimAddr::Tcp(addr), state })
    }

    /// Pin the attested clock (milliseconds since the Unix epoch), apart from chain time.
    pub fn set_clock_ms(&self, ms: Option<u64>) {
        self.state.lock().unwrap().clock_ms = ms;
    }
    pub fn set_debug(&self, debug: bool) {
        self.state.lock().unwrap().debug = debug;
    }
    pub fn set_pcr0_seed(&self, seed: u8) {
        self.state.lock().unwrap().pcr0_seed = seed;
    }
}

fn serve<S: std::io::Read + std::io::Write>(mut s: S, st: &Mutex<EnclaveConfig>, pki: &Pki) {
    while let Ok(req) = read_frame(&mut s) {
        let cfg = st.lock().unwrap().clone();
        let now = cfg.clock_ms.unwrap_or_else(wall_ms);
        let resp = match req["kind"].as_str() {
            Some("time") => json!({ "ok": true, "ms": now }),
            Some("attest") => attest(&req, &cfg, now, pki),
            _ => json!({ "ok": false, "error": "unknown request" }),
        };
        if write_frame(&mut s, &resp).is_err() {
            break;
        }
    }
}

fn attest(req: &Value, cfg: &EnclaveConfig, now_ms: u64, pki: &Pki) -> Value {
    let get = |k: &str, len: usize| -> Result<Option<Vec<u8>>, String> {
        match req.get(k).and_then(Value::as_str) {
            None => Ok(None),
            Some(s) => b64u::decode_len(s, len).map(Some).map_err(|e| format!("{k}: {e}")),
        }
    };
    // documented attestation-field limits for this protocol (notary_runtime.md §5): 181 / 32 / 32 bytes.
    let (user_data, public_key, nonce) = match (get("user_data", 181), get("public_key", 32), get("nonce", 32)) {
        (Ok(u), Ok(p), Ok(n)) => (u, p, n),
        (Err(e), _, _) | (_, Err(e), _) | (_, _, Err(e)) => return json!({ "ok": false, "error": e }),
    };
    let mut f = DocFields::new(pki, now_ms, pcrs(cfg.pcr0_seed, cfg.debug));
    f.user_data = user_data;
    f.public_key = public_key;
    f.nonce = nonce;
    json!({ "ok": true, "document": b64u::encode(&build_document(&f, &pki.leaf_key)) })
}
