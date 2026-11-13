//! The worker process (notary_runtime.md §3, §8): the framed protocol across real pipes, and, on Linux, that a running
//! worker is actually sandboxed (seccomp filter mode, no_new_privs, rlimits), read from /proc.
use notary_types::b64u;
use notary_worker::protocol::{read_frame, write_frame};
use serde_json::{json, Value};
use std::io::BufReader;
use std::process::{Command, Stdio};

fn program(body: &str) -> Vec<u8> {
    wat::parse_str(format!(
        r#"(module (import "notary_v1" "output_write" (func $out (param i32 i32) (result i32)))
             (memory (export "memory") 1 2) (data (i32.const 0) "{{\"ok\":true}}") {body})"#
    ))
    .unwrap()
}

#[test]
fn worker_speaks_the_section_8_protocol_over_pipes() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_notary-runtime")).args(["--mode", "worker"]).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut call = |m: Value| -> Value {
        write_frame(&mut stdin, &m).unwrap();
        read_frame(&mut stdout).unwrap().unwrap()
    };
    let p = program(r#"(func (export "run") (result i32) (drop (call $out (i32.const 0) (i32.const 11))) (i32.const 0))"#);
    let loaded = call(json!({ "kind": "load", "req_id": "1", "program": b64u::encode(&p), "limits": { "fuel": 1000, "memory_pages": 2 } }));
    assert_eq!(loaded["program_hash"], b64u::encode(&notary_crypto::sha256(&p)), "the worker hashes the program itself");
    let out = call(json!({ "kind": "run", "req_id": "2", "run_id": "r1", "params": "", "inputs": [] }));
    assert_eq!((out["kind"].as_str(), out["run_id"].as_str()), (Some("output"), Some("r1")));
    assert_eq!(b64u::decode(out["bytes"].as_str().unwrap()).unwrap(), br#"{"ok":true}"#);
    // a second program in the same worker is not possible without a new load; a spinning run hits the fuel limit
    let spin = program(r#"(func (export "run") (result i32) (loop $l (br $l)) (i32.const 0))"#);
    call(json!({ "kind": "load", "req_id": "3", "program": b64u::encode(&spin), "limits": { "fuel": 1000, "memory_pages": 2 } }));
    let err = call(json!({ "kind": "run", "req_id": "4", "run_id": "r2", "params": "", "inputs": [] }));
    assert_eq!((err["kind"].as_str(), err["reason"].as_str()), (Some("error"), Some("fuel")));
    write_frame(&mut stdin, &json!({ "kind": "terminate", "req_id": "5" })).unwrap();
    assert!(child.wait().unwrap().success());
}

#[cfg(target_os = "linux")]
#[test]
fn a_running_worker_is_sandboxed() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_notary-runtime")).args(["--mode", "worker", "--memory-bytes", "100000000", "--cpu-seconds", "30"])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    // a full load + run, so the process is past sandbox setup and has exercised the allowed syscalls
    let p = program(r#"(func (export "run") (result i32) (drop (memory.grow (i32.const 1))) (drop (call $out (i32.const 0) (i32.const 11))) (i32.const 0))"#);
    write_frame(&mut stdin, &json!({ "kind": "load", "req_id": "1", "program": b64u::encode(&p), "limits": { "fuel": 100000, "memory_pages": 2 } })).unwrap();
    assert_eq!(read_frame(&mut stdout).unwrap().unwrap()["kind"], "loaded");
    write_frame(&mut stdin, &json!({ "kind": "run", "req_id": "2", "run_id": "r", "params": "", "inputs": [] })).unwrap();
    assert_eq!(read_frame(&mut stdout).unwrap().unwrap()["kind"], "output", "the run works under the filter");
    let status = std::fs::read_to_string(format!("/proc/{}/status", child.id())).unwrap();
    assert!(status.lines().any(|l| l.starts_with("Seccomp:") && l.trim_end().ends_with('2')), "seccomp filter mode:\n{status}");
    assert!(status.lines().any(|l| l.starts_with("NoNewPrivs:") && l.trim_end().ends_with('1')));
    let limits = std::fs::read_to_string(format!("/proc/{}/limits", child.id())).unwrap();
    assert!(limits.lines().any(|l| l.starts_with("Max address space") && l.contains("100000000")), "{limits}");
    assert!(limits.lines().any(|l| l.starts_with("Max open files") && l.split_whitespace().nth(3) == Some("3")), "{limits}");
    write_frame(&mut stdin, &json!({ "kind": "terminate", "req_id": "3" })).unwrap();
    assert!(child.wait().unwrap().success(), "terminate exits cleanly under the filter");
}
