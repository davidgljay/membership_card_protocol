//! The broker's host connection (notary_runtime.md §9) and its main loop.
//!
//! One host connection at a time. `fetch` sends an enclave `fetch` and reads frames until the matching
//! `fetch_result`; any other message read meanwhile is queued and handled afterwards, in arrival order.
use crate::process_workers::ProcessWorkers;
use notary_broker::{
    cards_oracle::{CardPins, ListCardPin, SnapshotOracle},
    env::{HostIo, Platform},
    lists::{Keyset, Pins},
    Broker,
};
use notary_types::b64u;
use notary_worker::protocol::{read_frame, write_frame};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{Read, Write};

pub struct Conn<S: Read + Write> {
    stream: S,
    queue: VecDeque<Value>,
    seq: u64,
}

impl<S: Read + Write> HostIo for Conn<S> {
    fn send(&mut self, msg: Value) {
        let _ = write_frame(&mut self.stream, &msg);
    }
    fn fetch(&mut self, what: &str) -> Option<Vec<u8>> {
        self.seq += 1;
        let req_id = format!("fetch-{}", self.seq);
        write_frame(&mut self.stream, &json!({ "kind": "fetch", "req_id": req_id, "what": what })).ok()?;
        loop {
            let m = read_frame(&mut self.stream).ok()??;
            if m["kind"] == "fetch_result" && m["req_id"] == req_id.as_str() {
                return m["bytes"].as_str().and_then(|b| b64u::decode(b).ok());
            }
            self.queue.push_back(m);
        }
    }
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

/// The image's pins (runtime §12; E29): governance list cards and member keyset, version floors, the attestation root,
/// and the card trust anchors (trusted roots, app-certification root, login-service root).
fn load_pins(path: &str) -> Result<(Pins, CardPins, Vec<u8>), String> {
    let v: Value = serde_json::from_slice(&std::fs::read(path).map_err(|e| format!("{path}: {e}"))?).map_err(|e| format!("{path}: {e}"))?;
    let keys = v["keyset"]["keys"].as_array().ok_or("pins: keyset.keys")?.iter().map(|k| k.as_str().and_then(|s| b64u::decode(s).ok()).ok_or("pins: key")).collect::<Result<Vec<_>, _>>()?;
    let pins = Pins {
        accepted_runtimes_card: v["accepted_runtimes_card"].as_str().ok_or("pins: accepted_runtimes_card")?.into(),
        program_allowlist_card: v["program_allowlist_card"].as_str().ok_or("pins: program_allowlist_card")?.into(),
        keyset: Keyset { keys, quorum: v["keyset"]["quorum"].as_u64().ok_or("pins: quorum")? as usize, version: v["keyset"]["version"].as_u64().ok_or("pins: version")? as u32, key_scheme: v["keyset"]["key_scheme"].as_u64().unwrap_or(0) as u8 },
        accepted_runtimes_floor: v["accepted_runtimes_floor"].as_u64().unwrap_or(1),
        program_allowlist_floor: v["program_allowlist_floor"].as_u64().unwrap_or(1),
    };
    let root = b64u::decode(v["attestation_root"].as_str().ok_or("pins: attestation_root")?).map_err(|_| "pins: attestation_root")?;
    let strs = |k: &str| -> Result<Vec<String>, String> {
        v[k].as_array().ok_or(format!("pins: {k}"))?.iter().map(|x| x.as_str().map(String::from).ok_or(format!("pins: {k}"))).collect()
    };
    let cards = CardPins {
        trusted_roots: strs("trusted_roots")?,
        app_certification_root: v["app_certification_root"].as_str().ok_or("pins: app_certification_root")?.into(),
        login_service_root: v["login_service_root"].as_str().ok_or("pins: login_service_root")?.into(),
        max_chain_depth: v["max_chain_depth"].as_u64().unwrap_or(64) as usize,
        list_cards: [("accepted_runtimes", "accepted_runtimes_card", "accepted_runtimes_card_key"), ("program_allowlist", "program_allowlist_card", "program_allowlist_card_key")]
            .iter()
            .map(|(field, a, k)| -> Result<ListCardPin, String> {
                Ok(ListCardPin {
                    address: v[*a].as_str().ok_or(format!("pins: {a}"))?.into(),
                    public_key: b64u::decode(v[*k].as_str().ok_or(format!("pins: {k}"))?).map_err(|_| format!("pins: {k}"))?,
                    field: (*field).into(),
                })
            })
            .collect::<Result<_, _>>()?,
        list_holder_key: b64u::decode(v["list_holder_key"].as_str().ok_or("pins: list_holder_key")?).map_err(|_| "pins: list_holder_key")?,
        list_press_key: b64u::decode(v["list_press_key"].as_str().ok_or("pins: list_press_key")?).map_err(|_| "pins: list_press_key")?,
    };
    Ok((pins, cards, root))
}

fn platform(args: &[String], root: &[u8]) -> Result<Platform, String> {
    let spec = arg(args, "--attest").ok_or("--attest is required")?;
    let backend: Box<dyn notary_attest::AttestationBackend> = match spec.strip_prefix("sim:tcp:") {
        Some(addr) => Box::new(notary_attest::sim::SimulatorBackend::new(notary_attest::sim::SimAddr::Tcp(addr.into()))),
        None => return Err(format!("unsupported --attest {spec} (the AWS Nitro Enclaves backend is wired in Phase 8)")),
    };
    // Read this image's own PCR0 from a boot attestation, verified against the pinned root.
    let doc = backend.attest(notary_types::user_data::UserData { purpose: 0x03, ..Default::default() }.encode(), None, [0u8; 32]).map_err(|e| e.to_string())?;
    let env = notary_attest::aws::verify_envelope(&doc, root).map_err(|c| c.code().to_string())?;
    let clock_addr = spec.trim_start_matches("sim:tcp:").to_string();
    let clock = notary_attest::sim::SimulatorBackend::new(notary_attest::sim::SimAddr::Tcp(clock_addr));
    Ok(Platform { attest: backend, attested_time_ms: Box::new(move || clock.attested_time_ms().map_err(|e| e.to_string())), pcr0: env.measurement })
}

pub fn run_broker(args: &[String]) -> Result<(), String> {
    let (pins, card_pins, root) = load_pins(&arg(args, "--pins").ok_or("--pins is required")?)?;
    let platform = platform(args, &root)?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let workers = ProcessWorkers::new(exe, arg(args, "--worker-uid-base").and_then(|u| u.parse().ok()));
    // Card checks (5.3a). The policy and list-history reads fail closed until erratum E31 is answered.
    let mut broker = Broker::new(pins, Box::new(SnapshotOracle::new(card_pins)), Box::new(workers), platform);
    let listen = arg(args, "--listen").ok_or("--listen is required")?;
    let addr = listen.strip_prefix("tcp:").ok_or("only --listen tcp:HOST:PORT is supported here")?;
    let listener = std::net::TcpListener::bind(addr).map_err(|e| format!("{addr}: {e}"))?;
    eprintln!("notary-runtime broker {} listening on {addr}", broker.instance_id());
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let mut conn = Conn { stream, queue: VecDeque::new(), seq: 0 };
        loop {
            let msg = match conn.queue.pop_front() {
                Some(m) => m,
                None => match read_frame(&mut conn.stream) {
                    Ok(Some(m)) => m,
                    _ => break,
                },
            };
            broker.handle(&mut conn, &msg);
        }
    }
    Ok(())
}
