//! `fake-enclave`: the simulator's fake enclave service as a process (step 5.5, docker-compose.sim.yml).
//!
//!   fake-enclave --listen 0.0.0.0:7100 [--pcr0-seed 66]   # serve attestations and the attested clock (real time)
//!   fake-enclave --print-root                           # the test root certificate, base64url (for a pins file)
//!   fake-enclave --print-pcr0 [--pcr0-seed 66]          # the PCR0 this service reports, base64url
//!
//! Test use only: the root is the simulator's deterministic test root, which verifiers accept only when configured
//! for the simulator.
use notary_sim::{pcr0_of, test_root_der, EnclaveConfig, FakeEnclave};
use notary_types::b64u;

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let seed: u8 = arg(&args, "--pcr0-seed").and_then(|s| s.parse().ok()).unwrap_or(0x42);
    if args.iter().any(|a| a == "--print-root") {
        println!("{}", b64u::encode(&test_root_der()));
        return;
    }
    if args.iter().any(|a| a == "--print-pcr0") {
        println!("{}", b64u::encode(&pcr0_of(seed)));
        return;
    }
    let Some(listen) = arg(&args, "--listen") else {
        eprintln!("usage: fake-enclave --listen HOST:PORT [--pcr0-seed N] | --print-root | --print-pcr0");
        std::process::exit(2);
    };
    let svc = FakeEnclave::start_tcp(&listen, EnclaveConfig { pcr0_seed: seed, debug: false, clock_ms: None }).unwrap_or_else(|e| {
        eprintln!("fake-enclave: {listen}: {e}");
        std::process::exit(1);
    });
    eprintln!("fake-enclave listening on {:?} (pcr0 seed {seed})", svc.addr);
    loop {
        std::thread::park();
    }
}
