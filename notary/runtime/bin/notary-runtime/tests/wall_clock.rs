//! Runtime §8: the broker kills a worker whose run passes its wall-clock limit, and reports the run as a trap
//! (erratum E23). Uses the real `ProcessWorkers` and the real worker binary; the program spins with ample fuel, so
//! only the broker's timer can stop it.
#[path = "../src/process_workers.rs"]
#[allow(dead_code)]
mod process_workers;

use notary_admission::AdmittedLimits;
use notary_broker::env::Workers;
use notary_worker::RunError;
use process_workers::ProcessWorkers;
use std::time::{Duration, Instant};

fn program(body: &str) -> Vec<u8> {
    wat::parse_str(format!(
        r#"(module (import "notary_v1" "output_write" (func $out (param i32 i32) (result i32)))
             (memory (export "memory") 1 2) (data (i32.const 0) "{{\"ok\":true}}") {body})"#
    ))
    .unwrap()
}

#[test]
fn a_run_past_its_wall_clock_limit_is_killed_and_reported_as_a_trap() {
    let mut workers = ProcessWorkers::new(env!("CARGO_BIN_EXE_notary-runtime").into(), None);
    let job = [7u8; 32];
    let limits = AdmittedLimits { fuel: 1_000_000_000_000, memory_pages: 2, wall_ms: 400, max_inputs: 10 };
    let spin = program(r#"(func (export "run") (result i32) (loop $l (br $l)) (i32.const 0))"#);
    let t = Instant::now();
    let r = workers.run(&job, &spin, &limits, b"{}", &[]);
    let took = t.elapsed();
    assert_eq!(r.err(), Some(RunError::Trap), "killed at the wall-clock limit");
    assert!(took >= Duration::from_millis(400) && took < Duration::from_secs(10), "returned near the limit, not at fuel exhaustion: {took:?}");
    // the dead worker is gone: the same job runs a well-behaved program in a fresh worker
    let ok = program(r#"(func (export "run") (result i32) (drop (call $out (i32.const 0) (i32.const 11))) (i32.const 0))"#);
    let out = workers.run(&job, &ok, &AdmittedLimits { wall_ms: 5_000, ..limits }, b"{}", &[]).expect("a fresh worker runs");
    assert_eq!(out.bytes, br#"{"ok":true}"#);
    workers.stop(&job);
}
