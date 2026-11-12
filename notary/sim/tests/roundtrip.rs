//! The runtime's view of the simulator: `SimulatorBackend` → fake enclave socket → document → the same
//! verifier path production verifiers use (algorithm V) with the simulator root enabled.
use notary_attest::{
    sim::SimulatorBackend,
    verify::{verify_attestation, AcceptedRuntime, Config, Context, Expected},
    AttestationBackend,
};
use notary_sim::{pcr0_of, test_root_der, EnclaveConfig, FakeEnclave};
use notary_types::user_data::UserData;
use std::collections::BTreeMap;

fn cfg(allow: bool) -> Config {
    Config { roots: BTreeMap::from([("simulator".to_string(), test_root_der())]), allow_simulator: allow }
}

fn socket(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("notary-sim-{}-{name}.sock", std::process::id()))
}

fn expected(ud: &UserData) -> Expected {
    Expected { user_data: ud.clone(), nonce: Some(vec![7; 32]), public_key: Some(vec![8; 32]) }
}

fn accepted(seed: u8) -> Vec<AcceptedRuntime> {
    vec![AcceptedRuntime { pcr0: pcr0_of(seed), platform: "simulator".into(), accepted_from_ms: 0, retired_at_ms: None, retire_reason: None }]
}

#[test]
fn runtime_requests_a_per_job_attestation_and_verifiers_accept_it() {
    let svc = FakeEnclave::start_unix(socket("rt"), EnclaveConfig::default()).unwrap();
    let backend = SimulatorBackend::new(svc.addr.clone());
    assert_eq!(backend.platform(), "simulator");
    // purpose 0x02 (job): the broker binds K_id, K_inst, program, job and epoch
    let ud = UserData { purpose: 0x02, id_key_hash: [1; 32], inst_key_hash: [3; 32], program_hash: [4; 32], job_hash: [5; 32], epoch: 2, isolation: 1, ..Default::default() };
    let doc = backend.attest(ud.encode(), Some([8; 32]), [7; 32]).unwrap();
    let now = backend.attested_time_ms().unwrap() as i64;
    let acc = accepted(0x10);
    let ctx = Context { t_eval_ms: now, now_ms: now, max_age_ms: Some(60_000), accepted_runtimes: &acc, platform: "simulator" };
    let ok = verify_attestation(&doc, &cfg(true), &expected(&ud), &ctx).unwrap();
    assert_eq!(ok.measurement, pcr0_of(0x10));
    assert!(ok.warnings.is_empty());
    // the same document is refused by a production-configured verifier
    assert_eq!(verify_attestation(&doc, &cfg(false), &expected(&ud), &ctx), Err("ATT_PLATFORM_NOT_ALLOWED"));
    // a production root does not trust the simulator
    let mut prod = cfg(true);
    prod.roots.insert("simulator".into(), vec![0x30, 0x03, 0x02, 0x01, 0x01]);
    assert_eq!(verify_attestation(&doc, &prod, &expected(&ud), &ctx), Err("ATT_ROOT_MISMATCH"));
}

#[test]
fn pcrs_debug_flag_and_clock_are_configurable() {
    let svc = FakeEnclave::start_unix(socket("cfg"), EnclaveConfig { pcr0_seed: 0x42, ..Default::default() }).unwrap();
    let backend = SimulatorBackend::new(svc.addr.clone());
    let ud = UserData { purpose: 0x03, inst_key_hash: [3; 32], ..Default::default() };
    let acc = accepted(0x42);
    let attest_and_verify = |max_age: Option<i64>| {
        let doc = backend.attest(ud.encode(), Some([8; 32]), [7; 32]).unwrap();
        let now = backend.attested_time_ms().unwrap() as i64;
        let ctx = Context { t_eval_ms: now, now_ms: now, max_age_ms: max_age, accepted_runtimes: &acc, platform: "simulator" };
        verify_attestation(&doc, &cfg(true), &expected(&ud), &ctx).map(|v| v.measurement)
    };
    assert_eq!(attest_and_verify(None).unwrap(), pcr0_of(0x42));
    svc.set_debug(true);
    assert_eq!(attest_and_verify(None), Err("ATT_DEBUG_MODE"));
    svc.set_debug(false);
    // attested clock pinned apart from the real clock: the timestamp in documents and `time` follow it (T9 tests)
    svc.set_clock_ms(Some(1_900_000_000_000));
    assert_eq!(backend.attested_time_ms().unwrap(), 1_900_000_000_000);
    let doc = backend.attest(ud.encode(), Some([8; 32]), [7; 32]).unwrap();
    let ctx = Context { t_eval_ms: 1_900_000_000_000, now_ms: 1_900_000_000_000 + 10_000, max_age_ms: Some(60_000), accepted_runtimes: &acc, platform: "simulator" };
    assert!(verify_attestation(&doc, &cfg(true), &expected(&ud), &ctx).is_ok());
    // a runtime with another PCR0 is not on the list
    svc.set_pcr0_seed(0x77);
    let doc = backend.attest(ud.encode(), Some([8; 32]), [7; 32]).unwrap();
    assert_eq!(verify_attestation(&doc, &cfg(true), &expected(&ud), &ctx), Err("ATT_RUNTIME_NOT_ACCEPTED"));
}

#[test]
fn fake_enclave_service_enforces_the_documented_field_sizes() {
    let svc = FakeEnclave::start_tcp("127.0.0.1:0", EnclaveConfig::default()).unwrap();
    let backend = SimulatorBackend::new(svc.addr.clone());
    assert!(backend.attest([0u8; 181], None, [0u8; 32]).is_ok());
    // the framed protocol rejects a wrong-size user_data
    use notary_attest::sim::{read_frame, write_frame, SimAddr};
    use notary_types::b64u;
    let SimAddr::Tcp(a) = &svc.addr else { panic!() };
    let mut s = std::net::TcpStream::connect(a).unwrap();
    write_frame(&mut s, &serde_json::json!({ "kind": "attest", "user_data": b64u::encode(&[0u8; 180]), "nonce": b64u::encode(&[0u8; 32]) })).unwrap();
    assert_eq!(read_frame(&mut s).unwrap()["ok"], serde_json::json!(false));
}
