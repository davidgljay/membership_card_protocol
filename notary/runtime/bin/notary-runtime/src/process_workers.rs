//! `Workers` backed by one OS process per job (notary_runtime.md §3, §8). The broker starts
//! `notary-runtime --mode worker`, sends `load`, kills the worker if the `loaded` hash differs from the admitted
//! program's, and kills it when a run passes its wall-clock limit (`limits.wall_ms`).
use notary_admission::AdmittedLimits;
use notary_broker::env::Workers;
use notary_types::b64u;
use notary_worker::{protocol, RunError, RunOutput};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::BufReader;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::Duration;

struct Worker {
    child: Child,
    stdin: ChildStdin,
    replies: Receiver<Option<Value>>,
    seq: u64,
}

pub struct ProcessWorkers {
    exe: std::path::PathBuf,
    /// Base UID for workers (each job gets base + n) when the broker runs as root inside the enclave image.
    uid_base: Option<u32>,
    workers: BTreeMap<[u8; 32], Worker>,
    next_uid: u32,
}

impl ProcessWorkers {
    pub fn new(exe: std::path::PathBuf, uid_base: Option<u32>) -> Self {
        Self { exe, uid_base, workers: BTreeMap::new(), next_uid: 0 }
    }

    fn spawn(&mut self, job: &[u8; 32], program: &[u8], limits: &AdmittedLimits) -> Result<(), RunError> {
        let mut cmd = Command::new(&self.exe);
        cmd.args(["--mode", "worker", "--memory-bytes", &(limits.memory_pages as u64 * 65_536 + 48 * 1024 * 1024).to_string()]);
        if let Some(base) = self.uid_base {
            self.next_uid += 1;
            cmd.args(["--worker-uid", &(base + self.next_uid).to_string()]);
        }
        let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).env_clear().spawn().map_err(|_| RunError::Trap)?;
        let stdin = child.stdin.take().ok_or(RunError::Trap)?;
        let stdout = child.stdout.take().ok_or(RunError::Trap)?;
        let (tx, rx) = channel();
        std::thread::spawn(move || {
            let mut r = BufReader::new(stdout);
            loop {
                match protocol::read_frame(&mut r) {
                    Ok(Some(v)) => {
                        if tx.send(Some(v)).is_err() {
                            break;
                        }
                    }
                    _ => {
                        let _ = tx.send(None);
                        break;
                    }
                }
            }
        });
        let mut w = Worker { child, stdin, replies: rx, seq: 0 };
        protocol::write_frame(&mut w.stdin, &json!({ "kind": "load", "req_id": "load", "program": b64u::encode(program),
            "limits": { "fuel": limits.fuel, "memory_pages": limits.memory_pages } })).map_err(|_| RunError::Trap)?;
        let loaded = w.replies.recv_timeout(Duration::from_secs(30)).ok().flatten();
        let want = b64u::encode(&notary_crypto::sha256(program));
        if loaded.as_ref().and_then(|v| v["program_hash"].as_str()) != Some(want.as_str()) {
            let _ = w.child.kill();
            return Err(RunError::Trap);
        }
        self.workers.insert(*job, w);
        Ok(())
    }
}

impl Workers for ProcessWorkers {
    fn run(&mut self, job: &[u8; 32], program: &[u8], limits: &AdmittedLimits, params: &[u8], inputs: &[Vec<u8>]) -> Result<RunOutput, RunError> {
        if !self.workers.contains_key(job) {
            self.spawn(job, program, limits)?;
        }
        let w = self.workers.get_mut(job).expect("spawned");
        w.seq += 1;
        let run_id = format!("run-{}", w.seq);
        let msg = json!({ "kind": "run", "req_id": run_id, "run_id": run_id, "params": b64u::encode(params),
            "inputs": inputs.iter().map(|i| b64u::encode(i)).collect::<Vec<_>>() });
        if protocol::write_frame(&mut w.stdin, &msg).is_err() {
            self.stop(job);
            return Err(RunError::Trap);
        }
        match w.replies.recv_timeout(Duration::from_millis(limits.wall_ms)) {
            Ok(Some(v)) if v["kind"] == "output" => {
                let bytes = v["bytes"].as_str().and_then(|b| b64u::decode(b).ok()).ok_or(RunError::Trap)?;
                Ok(RunOutput { bytes, fuel_used: v["fuel_used"].as_u64().unwrap_or(0) })
            }
            Ok(Some(v)) => Err(match v["reason"].as_str().unwrap_or("trap") {
                "fuel" => RunError::Fuel,
                "memory" => RunError::Memory,
                "output_twice" => RunError::OutputTwice,
                "no_output" => RunError::NoOutput,
                r if r.starts_with("abort:") => RunError::Abort(r[6..].parse().unwrap_or(0)),
                _ => RunError::Trap,
            }),
            // Wall-clock limit passed, or the worker died (seccomp kill, rlimit): kill it; the run is a trap.
            _ => {
                self.stop(job);
                Err(RunError::Trap)
            }
        }
    }

    fn stop(&mut self, job: &[u8; 32]) {
        if let Some(mut w) = self.workers.remove(job) {
            let _ = protocol::write_frame(&mut w.stdin, &json!({ "kind": "terminate", "req_id": "t" }));
            let _ = w.child.kill();
            let _ = w.child.wait();
        }
    }
}
