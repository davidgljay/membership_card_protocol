//! `notary-runtime` — one binary, two modes (notary_runtime.md §2–§3).
//!
//! - `--mode worker`: runs one job's admitted program. Reads `load` / `run` / `terminate` on stdin, writes `loaded` /
//!   `output` / `error` on stdout (§8). On Linux it first drops to `--worker-uid` (if started as root), sets memory and
//!   CPU rlimits and installs a seccomp filter, so an interpreter escape lands in a process with no keys, no security-module access, no
//!   network and only its own job's payloads.
//! - `--mode broker`: listens for the host (`--listen tcp:HOST:PORT` or `unix:PATH`; vsock in the enclave image is
//!   reached through the same socket interface), attests with `--attest sim:tcp:HOST:PORT` (simulator; the AWS Nitro Enclaves backend is wired in
//!   Phase 8), and loads the image's governance pins from `--pins FILE` (inside the image, so covered by PCR0).
mod host_conn;
mod process_workers;
mod sandbox;

use std::io::{BufReader, BufWriter};

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match arg(&args, "--mode").as_deref() {
        Some("worker") => {
            let limits = sandbox::WorkerLimits {
                uid: arg(&args, "--worker-uid").and_then(|u| u.parse().ok()),
                memory_bytes: arg(&args, "--memory-bytes").and_then(|u| u.parse().ok()).unwrap_or(64 * 1024 * 1024),
                cpu_seconds: arg(&args, "--cpu-seconds").and_then(|u| u.parse().ok()).unwrap_or(120),
            };
            if let Err(e) = sandbox::enter(&limits) {
                eprintln!("worker sandbox: {e}");
                std::process::exit(70);
            }
            let (mut i, mut o) = (BufReader::new(std::io::stdin().lock()), BufWriter::new(std::io::stdout().lock()));
            let code = match notary_worker::protocol::serve(&mut i, &mut o) {
                Ok(()) => 0,
                Err(_) => 71,
            };
            sandbox::exit(code);
        }
        Some("broker") => {
            if let Err(e) = host_conn::run_broker(&args) {
                eprintln!("broker: {e}");
                std::process::exit(1);
            }
        }
        _ => {
            eprintln!("usage: notary-runtime --mode broker|worker [options]");
            std::process::exit(2);
        }
    }
}
