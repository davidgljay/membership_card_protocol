//! notary-guest — for writing `notary_v1` programs (notary_runtime.md §7) in Rust.
//!
//! - The seven ABI imports (`input_count`, `input_len`, `input_read`, `param_len`, `param_read`, `output_write`,
//!   `abort`), wrapped safely. On non-wasm targets they are replaced by a test harness, so program logic can be unit
//!   tested natively.
//! - `Output`: writes an RFC 8785 canonical JSON object of integer, boolean and enum-text fields (keys are sorted at
//!   `finish`), the only output types v1 allows (runtime §11).
//! - Integer fixed-point helpers. There is no float anywhere: admission rejects every float type and instruction (§6).
//!
//! A program's crate must also embed the `notary.abi` and `notary.output_schema` custom sections (A9); see the
//! templates (step 6.x) for the `#[link_section]` pattern.
#![no_std]

extern crate alloc;
use alloc::{string::String, vec::Vec};

#[cfg(target_arch = "wasm32")]
mod abi {
    #[link(wasm_import_module = "notary_v1")]
    extern "C" {
        pub fn input_count() -> i32;
        pub fn input_len(i: i32) -> i32;
        pub fn input_read(i: i32, ptr: i32, len: i32) -> i32;
        pub fn param_len() -> i32;
        pub fn param_read(ptr: i32, len: i32) -> i32;
        pub fn output_write(ptr: i32, len: i32) -> i32;
        pub fn abort(code: i32) -> !;
    }
}

/// Native stand-in for the ABI, so program logic is testable off-wasm.
#[cfg(not(target_arch = "wasm32"))]
pub mod harness {
    use alloc::vec::Vec;
    use core::cell::RefCell;
    extern crate std;
    std::thread_local! {
        pub static INPUTS: RefCell<Vec<Vec<u8>>> = const { RefCell::new(Vec::new()) };
        pub static PARAMS: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
        pub static OUTPUT: RefCell<Option<Vec<u8>>> = const { RefCell::new(None) };
    }
    pub fn set(params: &[u8], inputs: &[&[u8]]) {
        PARAMS.with(|p| *p.borrow_mut() = params.to_vec());
        INPUTS.with(|i| *i.borrow_mut() = inputs.iter().map(|x| x.to_vec()).collect());
        OUTPUT.with(|o| *o.borrow_mut() = None);
    }
    pub fn output() -> Option<Vec<u8>> {
        OUTPUT.with(|o| o.borrow().clone())
    }
}

/// Number of inputs in this run.
pub fn input_count() -> usize {
    #[cfg(target_arch = "wasm32")]
    unsafe {
        abi::input_count() as usize
    }
    #[cfg(not(target_arch = "wasm32"))]
    harness::INPUTS.with(|i| i.borrow().len())
}

/// Input `i`'s payload bytes (RFC 8785 JSON), in `input_hash` order.
pub fn input(i: usize) -> Vec<u8> {
    #[cfg(target_arch = "wasm32")]
    unsafe {
        let n = abi::input_len(i as i32) as usize;
        let mut buf = alloc::vec![0u8; n];
        abi::input_read(i as i32, buf.as_mut_ptr() as i32, n as i32);
        buf
    }
    #[cfg(not(target_arch = "wasm32"))]
    harness::INPUTS.with(|x| x.borrow().get(i).cloned().unwrap_or_else(|| fail(1)))
}

/// The job's `parameters` (RFC 8785 JSON).
pub fn params() -> Vec<u8> {
    #[cfg(target_arch = "wasm32")]
    unsafe {
        let n = abi::param_len() as usize;
        let mut buf = alloc::vec![0u8; n];
        abi::param_read(buf.as_mut_ptr() as i32, n as i32);
        buf
    }
    #[cfg(not(target_arch = "wasm32"))]
    harness::PARAMS.with(|p| p.borrow().clone())
}

/// Ends the run with a program error (`abort:<code>`).
pub fn fail(code: i32) -> ! {
    #[cfg(target_arch = "wasm32")]
    unsafe {
        abi::abort(code)
    }
    #[cfg(not(target_arch = "wasm32"))]
    panic!("abort:{code}")
}

fn write_output(bytes: &[u8]) {
    #[cfg(target_arch = "wasm32")]
    unsafe {
        abi::output_write(bytes.as_ptr() as i32, bytes.len() as i32);
    }
    #[cfg(not(target_arch = "wasm32"))]
    harness::OUTPUT.with(|o| {
        if o.borrow().is_some() {
            panic!("output_twice");
        }
        *o.borrow_mut() = Some(bytes.to_vec());
    })
}

enum Field {
    Int(i64),
    Bool(bool),
    Text(&'static str),
}

/// Canonical JSON object output. Field names must be plain ASCII without `"` or `\` (schema names are).
#[derive(Default)]
pub struct Output {
    fields: Vec<(&'static str, Field)>,
}

impl Output {
    pub fn int(mut self, name: &'static str, v: i64) -> Self {
        self.fields.push((name, Field::Int(v)));
        self
    }
    pub fn boolean(mut self, name: &'static str, v: bool) -> Self {
        self.fields.push((name, Field::Bool(v)));
        self
    }
    /// An enum value: must be one of the schema's `enum` strings.
    pub fn text(mut self, name: &'static str, v: &'static str) -> Self {
        self.fields.push((name, Field::Text(v)));
        self
    }
    /// The canonical bytes (keys sorted; all names are ASCII, so byte order equals UTF-16 order).
    pub fn to_bytes(mut self) -> Vec<u8> {
        self.fields.sort_by(|a, b| a.0.cmp(b.0));
        let mut s = String::from("{");
        for (i, (k, v)) in self.fields.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            s.push('"');
            s.push_str(k);
            s.push_str("\":");
            match v {
                Field::Int(x) => s.push_str(&itoa(*x)),
                Field::Bool(b) => s.push_str(if *b { "true" } else { "false" }),
                Field::Text(t) => {
                    s.push('"');
                    s.push_str(t);
                    s.push('"');
                }
            }
        }
        s.push('}');
        s.into_bytes()
    }
    /// Writes the output (once per run).
    pub fn finish(self) {
        write_output(&self.to_bytes());
    }
}

fn itoa(x: i64) -> String {
    let mut out = String::new();
    let neg = x < 0;
    let mut v = x.unsigned_abs();
    let mut digits = [0u8; 20];
    let mut n = 0;
    loop {
        digits[n] = b'0' + (v % 10) as u8;
        n += 1;
        v /= 10;
        if v == 0 {
            break;
        }
    }
    if neg {
        out.push('-');
    }
    for d in digits[..n].iter().rev() {
        out.push(*d as char);
    }
    out
}

/// Finds the integer value of `"key":` at the top level of a canonical JSON object (no nesting). For simple payloads.
pub fn json_int(json: &[u8], key: &str) -> Option<i64> {
    let start = find_value(json, key)?;
    let rest = &json[start..];
    let (neg, rest) = if rest.first() == Some(&b'-') { (true, &rest[1..]) } else { (false, rest) };
    let digits = rest.iter().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 {
        return None;
    }
    let mut v: i64 = 0;
    for c in &rest[..digits] {
        v = v.checked_mul(10)?.checked_add((c - b'0') as i64)?;
    }
    Some(if neg { -v } else { v })
}

/// Finds the string value of `"key":` at the top level (no escapes inside the value).
pub fn json_str<'a>(json: &'a [u8], key: &str) -> Option<&'a [u8]> {
    let start = find_value(json, key)?;
    let rest = json.get(start..)?;
    if rest.first() != Some(&b'"') {
        return None;
    }
    let end = rest[1..].iter().position(|c| *c == b'"')?;
    Some(&rest[1..1 + end])
}

fn find_value(json: &[u8], key: &str) -> Option<usize> {
    let mut pat = Vec::with_capacity(key.len() + 3);
    pat.push(b'"');
    pat.extend_from_slice(key.as_bytes());
    pat.extend_from_slice(b"\":");
    json.windows(pat.len()).position(|w| w == pat.as_slice()).map(|p| p + pat.len())
}

/// `round(a * b / d)` in exact integer arithmetic, ties to even (the same rule as the runtime's `round_to`).
pub fn mul_div_round(a: i64, b: i64, d: i64) -> i64 {
    if d == 0 {
        fail(2);
    }
    let n = a as i128 * b as i128;
    let (q, r) = (n.div_euclid(d as i128), n.rem_euclid(d as i128));
    let twice = 2 * r;
    let q = match twice.cmp(&(d as i128).abs()) {
        core::cmp::Ordering::Less => q,
        core::cmp::Ordering::Greater => q + 1,
        core::cmp::Ordering::Equal => q + (q & 1),
    };
    q as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    extern crate std;

    #[test]
    fn output_is_canonical() {
        let b = Output::default().int("yes", 27).boolean("quorate", true).text("majority", "yes").int("no", -3).to_bytes();
        assert_eq!(b, br#"{"majority":"yes","no":-3,"quorate":true,"yes":27}"#);
    }

    #[test]
    fn harness_runs_program_logic_natively() {
        harness::set(br#"{"options":2}"#, &[br#"{"choice":1}"#, br#"{"choice":0}"#, br#"{"choice":1}"#]);
        let opts = json_int(&params(), "options").unwrap();
        let ones = (0..input_count()).filter(|i| json_int(&input(*i), "choice") == Some(1)).count() as i64;
        Output::default().int("ones", ones).int("options", opts).finish();
        assert_eq!(harness::output().unwrap(), br#"{"ones":2,"options":2}"#);
        assert_eq!(json_str(br#"{"choice":"yes"}"#, "choice"), Some(&b"yes"[..]));
    }

    #[test]
    fn fixed_point_rounds_ties_to_even() {
        assert_eq!(mul_div_round(5, 1, 2), 2);
        assert_eq!(mul_div_round(7, 1, 2), 4);
        assert_eq!(mul_div_round(2, 3, 4), 2); // 1.5 → 2
        assert_eq!(mul_div_round(-5, 1, 2), -2);
        assert_eq!(mul_div_round(1_000_000_007, 3, 7), 428_571_432); // 428,571,431.57…
    }
}
