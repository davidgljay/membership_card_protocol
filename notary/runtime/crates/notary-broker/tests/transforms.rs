//! Output checks and privacy transforms (runtime §11), including a deliberately leaky program (step 5.3 Done-when):
//! whatever the program writes, the released output stays within the policy's declared ranges and granularity.
use notary_broker::transforms::{apply, check_schema, insufficient_participation_output, round_ties_even};
use notary_worker::{Program, RunLimits};
use serde_json::json;

fn schema() -> serde_json::Value {
    json!([
        { "name": "mean_score", "type": "integer", "required": true, "clamp": [0, 100], "round_to": 10 },
        { "name": "band", "type": "integer", "required": true, "clamp": [0, 1000], "buckets": [0, 10, 100, 500] },
        { "name": "rare", "type": "integer", "required": false, "suppress_cell_below_k": 5 },
        { "name": "majority", "type": "text", "required": true, "enum": ["yes", "no"] },
        { "name": "quorate", "type": "boolean", "required": true }
    ])
}

#[test]
fn round_to_is_nearest_with_ties_to_even() {
    assert_eq!(round_ties_even(14, 10), 10);
    assert_eq!(round_ties_even(16, 10), 20);
    assert_eq!(round_ties_even(15, 10), 20, "tie to the even multiple (2×10)");
    assert_eq!(round_ties_even(25, 10), 20, "tie to the even multiple (2×10)");
    assert_eq!(round_ties_even(35, 10), 40);
    assert_eq!(round_ties_even(-15, 10), -20);
    assert_eq!(round_ties_even(-25, 10), -20);
    assert_eq!(round_ties_even(7, 1), 7);
}

#[test]
fn transforms_apply_in_order() {
    check_schema(&schema()).unwrap();
    let out = apply(br#"{"band":742,"majority":"yes","mean_score":137,"quorate":true,"rare":3}"#, &schema()).unwrap();
    assert_eq!(out, json!({ "band": 500, "majority": "yes", "mean_score": 100, "quorate": true }), "clamp → round/bucket → suppress");
    let out = apply(br#"{"band":-5,"majority":"no","mean_score":45,"quorate":false,"rare":0}"#, &schema()).unwrap();
    assert_eq!(out, json!({ "band": 0, "majority": "no", "mean_score": 40, "quorate": false, "rare": 0 }), "0 is not suppressed");
    assert_eq!(insufficient_participation_output(), json!({ "insufficient_participation": true }));
}

#[test]
fn anything_outside_the_schema_is_a_violation() {
    let s = schema();
    for bad in [
        &br#"{"band":1,"majority":"yes","mean_score":1,"quorate":true,"secret":"alice"}"#[..], // extra field
        br#"{"band":1,"majority":"maybe","mean_score":1,"quorate":true}"#,                    // not in enum
        br#"{"band":1,"majority":"yes","mean_score":1}"#,                                       // required missing
        br#"{"band":1,"majority":"yes","mean_score":"1","quorate":true}"#,                    // wrong type
        br#"{"band":1,"majority":"yes","mean_score":1.5,"quorate":true}"#,                    // float
        br#"{ "band":1,"majority":"yes","mean_score":1,"quorate":true}"#,                     // not canonical
        br#"[1,2,3]"#,
        b"not json",
    ] {
        assert_eq!(apply(bad, &s), Err("OUTPUT_SCHEMA_VIOLATION"), "{}", String::from_utf8_lossy(bad));
    }
}

#[test]
fn bad_schemas_are_refused() {
    for s in [
        json!([{ "name": "x", "type": "integer", "round_to": 5, "buckets": [0, 5], "clamp": [0, 9] }]),
        json!([{ "name": "x", "type": "integer", "buckets": [0, 5] }]),
        json!([{ "name": "x", "type": "integer", "suppress_cell_below_k": 3, "required": true }]),
        json!([{ "name": "x", "type": "text" }]),
        json!([{ "name": "x", "type": "number" }]),
        json!([{ "name": "x", "type": "boolean" }, { "name": "x", "type": "boolean" }]),
    ] {
        assert!(check_schema(&s).is_err(), "{s}");
    }
}

/// A leaky program: copies the first contributor's raw input bytes into its output, and outputs an exact secret
/// number. The runtime's checks must stop the first and coarsen the second.
#[test]
fn a_deliberately_leaky_program_cannot_exceed_the_privacy_bounds() {
    let abi = r#"
      (import "notary_v1" "input_len" (func $len (param i32) (result i32)))
      (import "notary_v1" "input_read" (func $read (param i32 i32 i32) (result i32)))
      (import "notary_v1" "output_write" (func $out (param i32 i32) (result i32)))
      (memory (export "memory") 1 1)"#;
    // Writes {"secret":"<raw input 0>"} : an extra field carrying the input verbatim.
    let exfiltrate = format!(
        r#"(module {abi}
          (data (i32.const 0) "{{\"secret\":\"")
          (func (export "run") (result i32) (local $n i32)
            (local.set $n (call $read (i32.const 0) (i32.const 11) (call $len (i32.const 0))))
            (i32.store8 (i32.add (i32.const 11) (local.get $n)) (i32.const 34))
            (i32.store8 (i32.add (i32.const 12) (local.get $n)) (i32.const 125))
            (drop (call $out (i32.const 0) (i32.add (i32.const 13) (local.get $n))))
            (i32.const 0)))"#
    );
    let p = Program::load(&wat::parse_str(exfiltrate).unwrap()).unwrap();
    let raw = p.run(b"", &[b"alice-voted-yes".to_vec()], RunLimits::default()).unwrap();
    assert_eq!(raw.bytes, br#"{"secret":"alice-voted-yes"}"#, "the program did leak into its raw output");
    assert_eq!(apply(&raw.bytes, &schema()), Err("OUTPUT_SCHEMA_VIOLATION"), "…but nothing is released");

    // Encodes a contributor's exact value (37 = a secret score) in a declared integer field.
    let body = r#"{"band":742,"majority":"yes","mean_score":37,"quorate":true,"rare":2}"#;
    let exact = format!(
        r#"(module {abi}
          (data (i32.const 0) "{}")
          (func (export "run") (result i32) (drop (call $out (i32.const 0) (i32.const {}))) (i32.const 0)))"#,
        body.replace('"', "\\\""),
        body.len()
    );
    let p = Program::load(&wat::parse_str(exact).unwrap()).unwrap();
    let raw = p.run(b"", &[], RunLimits::default()).unwrap();
    let released = apply(&raw.bytes, &schema()).unwrap();
    assert_eq!(released, json!({ "band": 500, "majority": "yes", "mean_score": 40, "quorate": true }));
    // Every released integer is a declared multiple / bucket edge within the clamp, and the rare cell is gone.
    assert_eq!(released["mean_score"].as_i64().unwrap() % 10, 0);
    assert!([0, 10, 100, 500].contains(&released["band"].as_i64().unwrap()));
    assert!(released.get("rare").is_none());
}
