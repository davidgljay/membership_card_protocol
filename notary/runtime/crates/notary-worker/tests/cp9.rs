//! CP9 checkpoint 4 (notary_runtime.md §17): wasmi suitability.
//!
//! (a) The `notary_v1` engine refuses every feature runtime §6 rejects, and accepts the four allowed extensions.
//! (b) Fuel is deterministic: a fixed corpus consumes exactly the fuel recorded in
//!     `notary/vectors/fuel/corpus.json`. The same test runs in debug and release builds and with
//!     `--features portable-dispatch`; all must match the committed numbers.
//!     Regenerate (only when deliberately changing the ABI): `NOTARY_WRITE_VECTORS=1 cargo test -p notary-worker --test cp9`.
//! (c) The operator fuel table is frozen (hash of every entry).
use notary_worker::{engine, frozen_operator_cost, Program, RunError, RunLimits};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use wasmi::Module;

fn wasm(src: &str) -> Vec<u8> {
    wat::parse_str(src).expect("test wat must parse")
}

fn rejected(src: &str) -> bool {
    Module::new(&engine(), wasm(src)).is_err()
}

const ABI_IMPORTS: &str = r#"
  (import "notary_v1" "input_count" (func $input_count (result i32)))
  (import "notary_v1" "input_len" (func $input_len (param i32) (result i32)))
  (import "notary_v1" "input_read" (func $input_read (param i32 i32 i32) (result i32)))
  (import "notary_v1" "param_len" (func $param_len (result i32)))
  (import "notary_v1" "param_read" (func $param_read (param i32 i32) (result i32)))
  (import "notary_v1" "output_write" (func $output_write (param i32 i32) (result i32)))
  (import "notary_v1" "abort" (func $abort (param i32)))
"#;

fn program(body: &str) -> Program {
    let src = format!("(module {ABI_IMPORTS} (memory (export \"memory\") 1 4) {body})");
    Program::load(&wasm(&src)).expect("program must load")
}

#[test]
fn rejects_every_section_6_feature() {
    let cases: &[(&str, &str)] = &[
        ("float local", "(module (func (local f32)))"),
        ("float const", "(module (func (drop (f64.const 1.5))))"),
        ("float param", "(module (func (param f32)))"),
        ("float global", "(module (global f64 (f64.const 0)))"),
        ("saturating float conversion", "(module (func (param i32) (drop (i32.trunc_sat_f32_s (f32.const 1)))))"),
        ("simd", "(module (func (drop (v128.const i32x4 0 0 0 0))))"),
        ("shared memory (threads)", "(module (memory 1 1 shared))"),
        ("atomics", "(module (memory 1 1 shared) (func (drop (i32.atomic.load (i32.const 0)))))"),
        ("reference types: externref", "(module (table 1 externref))"),
        ("reference types: two tables", "(module (table 1 funcref) (table 1 funcref))"),
        ("reference types: ref.null", "(module (func (drop (ref.null func))))"),
        ("tail calls", "(module (func $f (return_call $f)))"),
        ("exceptions", "(module (tag $t) (func (throw $t)))"),
        ("memory64", "(module (memory i64 1))"),
        ("multi-memory", "(module (memory 1) (memory 1))"),
        ("start function", "(module (func $s) (start $s))"),
        ("extended const", "(module (global i32 (i32.add (i32.const 1) (i32.const 2))))"),
        ("wide arithmetic", "(module (func (param i64 i64 i64 i64) (drop (drop (i64.add128 (local.get 0) (local.get 1) (local.get 2) (local.get 3))))))"),
        ("custom page sizes", "(module (memory 1 (pagesize 1)))"),
        ("GC", "(module (type (struct)))"),
    ];
    for (name, src) in cases {
        assert!(rejected(src), "engine accepted a §6-rejected feature: {name}");
    }
    // The component model: a component is not a module.
    let component = wat::parse_str("(component)").expect("component wat");
    assert!(Module::new(&engine(), component).is_err(), "engine accepted a component");
}

#[test]
fn accepts_the_four_allowed_extensions() {
    let cases: &[(&str, &str)] = &[
        ("mutable-global", "(module (global (export \"g\") (mut i32) (i32.const 0)))"),
        ("sign-extension", "(module (func (param i32) (result i32) (i32.extend8_s (local.get 0))))"),
        ("multi-value", "(module (func (result i32 i32) (i32.const 1) (i32.const 2)))"),
        (
            "bulk-memory",
            "(module (memory 1) (data $d \"abc\") (func (memory.copy (i32.const 0) (i32.const 8) (i32.const 4)) (memory.fill (i32.const 0) (i32.const 0) (i32.const 4)) (memory.init $d (i32.const 0) (i32.const 0) (i32.const 3)) (data.drop $d)))",
        ),
    ];
    for (name, src) in cases {
        assert!(!rejected(src), "engine refused an allowed extension: {name}");
    }
}

#[test]
fn operator_table_is_frozen() {
    // Changing the table (for example by upgrading wasmi) must fail here and require a new ABI string.
    let table = format!("{:?}", frozen_operator_cost());
    let digest = hex(&Sha256::digest(table.as_bytes()));
    assert_eq!(digest, FROZEN_TABLE_SHA256, "the notary_v1 operator fuel table changed: {table}");
}

const FROZEN_TABLE_SHA256: &str = "e3e98616a3fa907176efaa0321cfff839573093eea489742bde04645b981cea4";

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

// ---------------------------------------------------------------------------------------------------------------
// ABI behaviour (runtime §7, §8)

const OUT_CONST: &str = r#"(data (i32.const 0) "{\"ok\":true}") (func (export "run") (result i32) (drop (call $output_write (i32.const 0) (i32.const 11))) (i32.const 0))"#;

#[test]
fn abi_output_and_errors() {
    let ok = program(OUT_CONST);
    let out = ok.run(b"", &[], RunLimits::default()).unwrap();
    assert_eq!(out.bytes, br#"{"ok":true}"#);

    let twice = program(r#"(func (export "run") (result i32) (drop (call $output_write (i32.const 0) (i32.const 1))) (drop (call $output_write (i32.const 0) (i32.const 1))) (i32.const 0))"#);
    assert_eq!(twice.run(b"", &[], RunLimits::default()), Err(RunError::OutputTwice));

    let none = program(r#"(func (export "run") (result i32) (i32.const 0))"#);
    assert_eq!(none.run(b"", &[], RunLimits::default()), Err(RunError::NoOutput));

    let abort = program(r#"(func (export "run") (result i32) (call $abort (i32.const 7)) (i32.const 0))"#);
    assert_eq!(abort.run(b"", &[], RunLimits::default()), Err(RunError::Abort(7)));
    assert_eq!(RunError::Abort(7).reason(), "abort:7");

    let trap = program(r#"(func (export "run") (result i32) unreachable)"#);
    assert_eq!(trap.run(b"", &[], RunLimits::default()), Err(RunError::Trap));

    let spin = program(r#"(func (export "run") (result i32) (loop $l (br $l)) (i32.const 0))"#);
    assert_eq!(spin.run(b"", &[], RunLimits { fuel: 10_000, memory_pages: 4 }), Err(RunError::Fuel));

    let grow = program(r#"(func (export "run") (result i32) (drop (memory.grow (i32.const 3))) (i32.const 0))"#);
    assert_eq!(grow.run(b"", &[], RunLimits { fuel: 10_000, memory_pages: 2 }), Err(RunError::Memory));

    let oob_index = program(r#"(func (export "run") (result i32) (drop (call $input_len (i32.const 5))) (i32.const 0))"#);
    assert_eq!(oob_index.run(b"", &[b"x".to_vec()], RunLimits::default()), Err(RunError::Trap));

    let oob_dest = program(r#"(func (export "run") (result i32) (drop (call $input_read (i32.const 0) (i32.const 65535) (i32.const 8))) (i32.const 0))"#);
    assert_eq!(oob_dest.run(b"", &[b"12345678".to_vec()], RunLimits::default()), Err(RunError::Trap));
}

/// Echo: writes input 0 followed by the parameters, so reads are observable.
const ECHO: &str = r#"
  (func (export "run") (result i32) (local $n i32) (local $p i32)
    (local.set $n (call $input_read (i32.const 0) (i32.const 1024) (call $input_len (i32.const 0))))
    (local.set $p (call $param_read (i32.add (i32.const 1024) (local.get $n)) (call $param_len)))
    (drop (call $output_write (i32.const 1024) (i32.add (local.get $n) (local.get $p))))
    (i32.const 0))"#;

#[test]
fn abi_reads_inputs_and_params() {
    let p = program(ECHO);
    let out = p.run(b"PARAMS", &[b"INPUT".to_vec()], RunLimits::default()).unwrap();
    assert_eq!(out.bytes, b"INPUTPARAMS");
    assert_eq!(p.run(b"", &[vec![]], RunLimits::default()).unwrap().bytes, b"");
}

#[test]
fn every_run_gets_a_fresh_instance() {
    // A global incremented on each run: if state carried over, the second run would see 2.
    let p = program(
        r#"(global $g (mut i32) (i32.const 0))
           (func (export "run") (result i32)
             (global.set $g (i32.add (global.get $g) (i32.const 1)))
             (i32.store8 (i32.const 0) (i32.add (i32.const 48) (global.get $g)))
             (drop (call $output_write (i32.const 0) (i32.const 1))) (i32.const 0))"#,
    );
    assert_eq!(p.run(b"", &[], RunLimits::default()).unwrap().bytes, b"1");
    assert_eq!(p.run(b"", &[], RunLimits::default()).unwrap().bytes, b"1");
}

// ---------------------------------------------------------------------------------------------------------------
// Fuel determinism corpus

fn corpus() -> Vec<(&'static str, String, Vec<Vec<u8>>, Vec<u8>)> {
    let sum_loop = r#"
      (func (export "run") (result i32) (local $i i32) (local $acc i64)
        (loop $l
          (local.set $acc (i64.add (local.get $acc) (i64.extend_i32_u (i32.mul (local.get $i) (local.get $i)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br_if $l (i32.lt_u (local.get $i) (i32.const 100000))))
        (i64.store (i32.const 0) (local.get $acc))
        (drop (call $output_write (i32.const 0) (i32.const 8))) (i32.const 0))"#;
    let fib = r#"
      (func $fib (param $n i32) (result i32)
        (if (result i32) (i32.lt_u (local.get $n) (i32.const 2))
          (then (local.get $n))
          (else (i32.add (call $fib (i32.sub (local.get $n) (i32.const 1))) (call $fib (i32.sub (local.get $n) (i32.const 2)))))))
      (func (export "run") (result i32)
        (i32.store (i32.const 0) (call $fib (i32.const 22)))
        (drop (call $output_write (i32.const 0) (i32.const 4))) (i32.const 0))"#;
    let bulk = r#"
      (func (export "run") (result i32) (local $i i32)
        (drop (memory.grow (i32.const 1)))
        (memory.fill (i32.const 0) (i32.const 7) (i32.const 60000))
        (loop $l
          (memory.copy (i32.const 65536) (i32.const 0) (i32.const 60000))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br_if $l (i32.lt_u (local.get $i) (i32.const 50))))
        (drop (call $output_write (i32.const 65536) (i32.const 32))) (i32.const 0))"#;
    let multi = r#"
      (func $divmod (param i32 i32) (result i32 i32)
        (i32.div_u (local.get 0) (local.get 1)) (i32.rem_u (local.get 0) (local.get 1)))
      (func (export "run") (result i32) (local $i i32) (local $a i32) (local $q i32) (local $r i32)
        (loop $l
          (call $divmod (i32.add (local.get $i) (i32.const 1000)) (i32.const 7))
          (local.set $r) (local.set $q)
          (local.set $a (i32.add (local.get $a) (i32.extend16_s (i32.add (local.get $q) (local.get $r)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br_if $l (i32.lt_u (local.get $i) (i32.const 20000))))
        (i32.store (i32.const 0) (local.get $a))
        (drop (call $output_write (i32.const 0) (i32.const 4))) (i32.const 0))"#;
    let tally = r#"
      (func (export "run") (result i32) (local $i i32) (local $n i32) (local $len i32) (local $j i32) (local $h i32)
        (local.set $n (call $input_count))
        (loop $each
          (if (i32.lt_u (local.get $i) (local.get $n)) (then
            (local.set $len (call $input_read (local.get $i) (i32.const 4096) (call $input_len (local.get $i))))
            (local.set $j (i32.const 0))
            (loop $bytes
              (if (i32.lt_u (local.get $j) (local.get $len)) (then
                (local.set $h (i32.add (i32.mul (local.get $h) (i32.const 31)) (i32.load8_u (i32.add (i32.const 4096) (local.get $j)))))
                (local.set $j (i32.add (local.get $j) (i32.const 1)))
                (br $bytes))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $each))))
        (i32.store (i32.const 0) (local.get $h))
        (drop (call $output_write (i32.const 0) (i32.const 4))) (i32.const 0))"#;
    let ballots: Vec<Vec<u8>> = (0..200).map(|i| format!("{{\"choice\":{}}}", i % 3).into_bytes()).collect();
    vec![
        ("sum_loop", sum_loop.to_string(), vec![], vec![]),
        ("fib_22", fib.to_string(), vec![], vec![]),
        ("bulk_memory", bulk.to_string(), vec![], vec![]),
        ("multi_value_sign_ext", multi.to_string(), vec![], vec![]),
        ("tally_200_inputs", tally.to_string(), ballots, b"{\"options\":3}".to_vec()),
    ]
}

#[test]
fn fuel_is_deterministic() {
    let mut got = Vec::new();
    for (name, body, inputs, params) in corpus() {
        let p = program(&body);
        let o = p.run(&params, &inputs, RunLimits::default()).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        got.push(json!({ "name": name, "fuel_used": o.fuel_used, "output_sha256": hex(&Sha256::digest(&o.bytes)) }));
    }
    let got = json!({
        "about": "CP9 checkpoint 4: fuel consumed by the notary_v1 engine (wasmi =2.0.0, frozen table) for a fixed corpus. Must be identical in every build.",
        "abi": "notary_v1",
        "cases": got,
    });
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../vectors/fuel/corpus.json");
    if std::env::var("NOTARY_WRITE_VECTORS").is_ok() {
        std::fs::create_dir_all(std::path::Path::new(path).parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_string_pretty(&got).unwrap() + "\n").unwrap();
    }
    let want: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("fuel corpus vectors missing")).unwrap();
    assert_eq!(got, want, "fuel differs from the committed notary_v1 corpus");
}
