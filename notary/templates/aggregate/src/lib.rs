//! The `aggregate` template (code-plan §2; implementation step 6.1): a histogram of one integer value per contributor.
//!
//! - **Input** (`input_schema`): `{ "value": integer }`, bounded by the policy (`min`, `max`).
//! - **Parameters** (`parameter_bounds`): `edge_1 … edge_7`, optional integers in strictly ascending order. They are
//!   the bucket edges: `bucket_1` counts `value < edge_1`, `bucket_k` counts `edge_{k-1} ≤ value < edge_k`, and the last
//!   bucket in use counts everything from the last edge up. Buckets beyond the edges given stay 0.
//! - **Output** (`schema.json`, embedded as `notary.output_schema`): `count`, `sum`, `bucket_1 … bucket_8`, with the
//!   privacy transforms in the schema (clamps, and small-cell suppression below 5).
//!
//! Integers only: there is no float type or instruction in this module (runtime §6). A bad input or parameter set aborts
//! the run (`abort:3` for a value that is missing, `abort:4` for edges that are not ascending).
#![cfg_attr(target_arch = "wasm32", no_std)]

#[cfg(target_arch = "wasm32")]
extern crate alloc;

use notary_guest as g;

/// The ABI version and the output schema, as the custom sections admission checks (A9).
#[cfg(target_arch = "wasm32")]
#[link_section = "notary.abi"]
#[used]
static ABI: [u8; 9] = *b"notary_v1";

const SCHEMA_JSON: &[u8] = include_bytes!("../schema.json");
#[cfg(target_arch = "wasm32")]
#[link_section = "notary.output_schema"]
#[used]
static SCHEMA: [u8; SCHEMA_JSON.len()] = {
    let mut out = [0u8; SCHEMA_JSON.len()];
    let mut i = 0;
    while i < out.len() {
        out[i] = SCHEMA_JSON[i];
        i += 1;
    }
    out
};

pub const MAX_BUCKETS: usize = 8;

/// The result of one run.
#[derive(Debug, PartialEq, Eq)]
pub struct Totals {
    pub count: i64,
    pub sum: i64,
    pub buckets: [i64; MAX_BUCKETS],
}

/// Bucket index of `v` for ascending `edges`: the number of edges at or below `v`.
pub fn bucket_of(v: i64, edges: &[i64]) -> usize {
    edges.iter().filter(|e| **e <= v).count()
}

/// The histogram. `edges` must be strictly ascending and at most `MAX_BUCKETS - 1` long; returns `None` otherwise.
pub fn aggregate(values: &[i64], edges: &[i64]) -> Option<Totals> {
    if edges.len() >= MAX_BUCKETS || edges.windows(2).any(|w| w[0] >= w[1]) {
        return None;
    }
    let mut t = Totals { count: 0, sum: 0, buckets: [0; MAX_BUCKETS] };
    for v in values {
        t.count += 1;
        t.sum = t.sum.saturating_add(*v);
        t.buckets[bucket_of(*v, edges)] += 1;
    }
    Some(t)
}

const BUCKET_NAMES: [&str; MAX_BUCKETS] = ["bucket_1", "bucket_2", "bucket_3", "bucket_4", "bucket_5", "bucket_6", "bucket_7", "bucket_8"];
const EDGE_NAMES: [&str; MAX_BUCKETS - 1] = ["edge_1", "edge_2", "edge_3", "edge_4", "edge_5", "edge_6", "edge_7"];

/// The program body: reads the inputs and parameters through the ABI and writes the output.
pub fn run_program() {
    let params = g::params();
    let mut edges = [0i64; MAX_BUCKETS - 1];
    let mut n_edges = 0;
    for name in EDGE_NAMES {
        match g::json_int(&params, name) {
            Some(e) => {
                edges[n_edges] = e;
                n_edges += 1;
            }
            None => break,
        }
    }
    let mut values = alloc_vec();
    for i in 0..g::input_count() {
        match g::json_int(&g::input(i), "value") {
            Some(v) => values.push(v),
            None => g::fail(3),
        }
    }
    let Some(t) = aggregate(&values, &edges[..n_edges]) else { g::fail(4) };
    let mut out = g::Output::default().int("count", t.count).int("sum", t.sum);
    for (name, v) in BUCKET_NAMES.iter().zip(t.buckets) {
        out = out.int(name, v);
    }
    out.finish();
}

#[cfg(target_arch = "wasm32")]
fn alloc_vec() -> alloc::vec::Vec<i64> {
    alloc::vec::Vec::new()
}
#[cfg(not(target_arch = "wasm32"))]
fn alloc_vec() -> Vec<i64> {
    Vec::new()
}

/// The module's `run` export (`() -> i32`).
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn run() -> i32 {
    run_program();
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_is_the_canonical_form_of_the_policy_schema() {
        let policy: serde_json::Value = serde_json::from_str(include_str!("../policy.json")).unwrap();
        let canonical = notary_types::jcs::canonical(&policy["notary"]["output_schema"]).unwrap();
        assert_eq!(canonical, SCHEMA_JSON, "schema.json must be the canonical output_schema of policy.json");
    }

    #[test]
    fn buckets_follow_the_edges() {
        let t = aggregate(&[1, 5, 5, 9, 10, 100, -4], &[5, 10]).unwrap();
        assert_eq!((t.count, t.sum), (7, 126));
        assert_eq!(&t.buckets[..4], &[2, 3, 2, 0]); // <5: 1,-4   5..10: 5,5,9   ≥10: 10,100
        assert_eq!(aggregate(&[], &[]).unwrap(), Totals { count: 0, sum: 0, buckets: [0; 8] });
        assert_eq!(aggregate(&[3, 4], &[]).unwrap().buckets[0], 2, "no edges: one bucket");
    }

    #[test]
    fn edges_must_ascend_and_fit() {
        assert!(aggregate(&[1], &[5, 5]).is_none());
        assert!(aggregate(&[1], &[6, 5]).is_none());
        assert!(aggregate(&[1], &[1, 2, 3, 4, 5, 6, 7, 8]).is_none());
        assert!(aggregate(&[1], &[1, 2, 3, 4, 5, 6, 7]).is_some());
    }

    #[test]
    fn the_program_reads_inputs_and_parameters_and_writes_canonical_output() {
        g::harness::set(br#"{"edge_1":5,"edge_2":10}"#, &[br#"{"value":1}"#, br#"{"value":7}"#, br#"{"value":12}"#, br#"{"value":9}"#]);
        run_program();
        let out = g::harness::output().unwrap();
        assert_eq!(
            String::from_utf8(out).unwrap(),
            r#"{"bucket_1":1,"bucket_2":2,"bucket_3":1,"bucket_4":0,"bucket_5":0,"bucket_6":0,"bucket_7":0,"bucket_8":0,"count":4,"sum":29}"#
        );
    }
}
