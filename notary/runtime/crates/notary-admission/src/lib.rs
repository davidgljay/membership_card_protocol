//! notary-admission — algorithm A (notary_runtime.md §6) and the `notary-lint` warnings.
//!
//! The runtime runs `admit` when it loads a program for a job, **before** generating any job key. `notary-lint`
//! runs the same checks at policy creation (lifecycle Phase 1, step 11), plus `lint_warnings`.
//!
//! Checks run in the order A1–A11. The policy-level refusals of deferred features (`ADM_DP_UNSUPPORTED`,
//! `ADM_FEATURE_UNSUPPORTED`, runtime §11 and §16) run first: they need no program bytes.
use notary_types::{formats, jcs};
use serde_json::Value;
use sha2::{Digest, Sha256};
use wasmparser::{ExternalKind, FuncType, Parser, Payload, TypeRef, ValType, Validator, WasmFeatures};

/// Runtime ceilings (runtime §14), provisional until step 5.6.
pub const MAX_MODULE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_MEMORY_PAGES: u64 = 256;
pub const MAX_TABLE_ELEMENTS: u64 = 1024;
pub const MAX_FUNCTIONS: u32 = 10_000;
pub const MAX_LOCALS_PER_FUNCTION: u32 = 1_000;
pub const MAX_GLOBALS: u32 = 1_000;
pub const MAX_DATA_BYTES: usize = 1024 * 1024;
pub const MAX_FUEL: u64 = 1_000_000_000;
pub const MAX_WALL_MS: u64 = 60_000;
pub const MAX_INPUTS: u64 = 100_000;
pub const ABI_VERSION: &str = "notary_v1";

/// The seven `notary_v1` imports and their exact signatures (runtime §7): (params, results), all `i32`.
pub const ABI_IMPORTS: [(&str, usize, usize); 7] = [
    ("input_count", 0, 1),
    ("input_len", 1, 1),
    ("input_read", 3, 1),
    ("param_len", 0, 1),
    ("param_read", 2, 1),
    ("output_write", 2, 1),
    ("abort", 1, 0),
];

/// The WebAssembly features §6 allows: 1.0 (MVP) without floats, plus mutable-global, sign-extension, multi-value
/// and bulk-memory. `GC_TYPES` is part of wasmparser's MVP set (it gates `funcref` itself), not the GC proposal.
pub fn allowed_features() -> WasmFeatures {
    WasmFeatures::MUTABLE_GLOBAL
        | WasmFeatures::SIGN_EXTENSION
        | WasmFeatures::MULTI_VALUE
        | WasmFeatures::BULK_MEMORY
        | WasmFeatures::GC_TYPES
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdmissionError {
    pub code: &'static str,
    pub detail: String,
}

impl AdmissionError {
    fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self { code, detail: detail.into() }
    }
}

impl std::fmt::Display for AdmissionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.detail)
    }
}

/// One program allowlist entry (§34), already verified by algorithm L.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllowlistEntry {
    pub program_cid: String,
    pub accepted_from_ms: i64,
    pub retired_at_ms: Option<i64>,
}

/// What A11 needs from the runtime. `notary-lint` passes `None` for the allowlist when it has none.
#[derive(Debug, Clone, Default)]
pub struct RuntimeContext<'a> {
    pub allowlist: Option<&'a [AllowlistEntry]>,
    pub now_ms: i64,
    /// Jobs this runtime already holds (A11, dedicated).
    pub held_jobs: usize,
}

/// The policy's run limits after A10, with absent fields at the runtime defaults.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AdmittedLimits {
    pub fuel: u64,
    pub memory_pages: u32,
    pub wall_ms: u64,
    pub max_inputs: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Admitted {
    pub program_hash: [u8; 32],
    pub limits: AdmittedLimits,
    pub isolation: Isolation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Isolation {
    Shared,
    Dedicated,
}

/// Refusals of specified-but-deferred policy features (runtime §11, §16).
pub fn check_deferred_features(notary: &Value) -> Result<(), AdmissionError> {
    if notary.get("privacy").and_then(|p| p.get("dp")).is_some() {
        return Err(AdmissionError::new("ADM_DP_UNSUPPORTED", "privacy.dp is specified but not supported in v1"));
    }
    if notary.pointer("/revocation_propagation/mode").and_then(Value::as_str) == Some("escrowed_link") {
        return Err(AdmissionError::new("ADM_FEATURE_UNSUPPORTED", "revocation_propagation.mode escrowed_link"));
    }
    match notary.pointer("/derived_card/source_kind") {
        None => {}
        Some(Value::String(s)) if s == "card" => {}
        Some(other) => return Err(AdmissionError::new("ADM_FEATURE_UNSUPPORTED", format!("derived_card.source_kind {other}"))),
    }
    Ok(())
}

/// A10: the policy's limits within the runtime ceilings (runtime §14).
pub fn check_limits(notary: &Value) -> Result<AdmittedLimits, AdmissionError> {
    let l = notary.get("limits");
    let get = |k: &str, ceiling: u64| -> Result<u64, AdmissionError> {
        match l.and_then(|l| l.get(k)) {
            None => Ok(ceiling),
            Some(v) => match v.as_u64() {
                Some(x) if x >= 1 && x <= ceiling => Ok(x),
                _ => Err(AdmissionError::new("ADM_LIMITS_EXCEED_CEILING", format!("limits.{k} must be an integer in 1..={ceiling}"))),
            },
        }
    };
    if let Some(Value::Object(m)) = l {
        if let Some(k) = m.keys().find(|k| !["fuel", "memory_pages", "wall_ms", "max_inputs"].contains(&k.as_str())) {
            return Err(AdmissionError::new("ADM_LIMITS_EXCEED_CEILING", format!("unknown limit {k}")));
        }
    }
    Ok(AdmittedLimits {
        fuel: get("fuel", MAX_FUEL)?,
        memory_pages: get("memory_pages", MAX_MEMORY_PAGES)? as u32,
        wall_ms: get("wall_ms", MAX_WALL_MS)?,
        max_inputs: get("max_inputs", MAX_INPUTS)?,
    })
}

fn is_abi_signature(ty: &FuncType, params: usize, results: usize) -> bool {
    ty.params().len() == params
        && ty.results().len() == results
        && ty.params().iter().chain(ty.results()).all(|t| *t == ValType::I32)
}

/// Algorithm A: A1–A11 (runtime §6). `notary` is the policy's `notary` section.
pub fn admit(program: &[u8], notary: &Value, ctx: &RuntimeContext<'_>) -> Result<Admitted, AdmissionError> {
    check_deferred_features(notary)?;

    // A1: program_cid is CIDv1 raw sha2-256, and its digest is SHA-256 of the bytes.
    let cid = notary.get("program_cid").and_then(Value::as_str).ok_or_else(|| AdmissionError::new("ADM_HASH_MISMATCH", "program_cid missing"))?;
    let digest = formats::digest_from_cid(cid).map_err(|e| AdmissionError::new("ADM_HASH_MISMATCH", e.message))?;
    let program_hash: [u8; 32] = Sha256::digest(program).into();
    if digest != program_hash {
        return Err(AdmissionError::new("ADM_HASH_MISMATCH", "SHA-256 of the module differs from program_cid"));
    }

    // A2: size.
    if program.len() > MAX_MODULE_BYTES {
        return Err(AdmissionError::new("ADM_TOO_LARGE", format!("{} bytes > 4 MiB", program.len())));
    }

    // A3: validates under the allowed feature set; no start function.
    Validator::new_with_features(allowed_features())
        .validate_all(program)
        .map_err(|e| AdmissionError::new("ADM_FEATURE_DISALLOWED", e.message().to_string()))?;

    let mut types: Vec<FuncType> = Vec::new();
    let mut imports: Vec<(String, String, TypeRef)> = Vec::new();
    let mut memories: Vec<wasmparser::MemoryType> = Vec::new();
    let mut tables: Vec<wasmparser::TableType> = Vec::new();
    let mut func_type_idx: Vec<u32> = Vec::new();
    let mut imported_funcs = 0u32;
    let mut globals = 0u32;
    let mut data_bytes = 0usize;
    let mut exports: Vec<(String, ExternalKind, u32)> = Vec::new();
    let mut customs: Vec<(String, Vec<u8>)> = Vec::new();
    let mut max_locals = 0u32;
    let mut has_start = false;

    for payload in Parser::new(0).parse_all(program) {
        let payload = payload.map_err(|e| AdmissionError::new("ADM_FEATURE_DISALLOWED", e.message().to_string()))?;
        let pe = |e: wasmparser::BinaryReaderError| AdmissionError::new("ADM_FEATURE_DISALLOWED", e.message().to_string());
        match payload {
            Payload::TypeSection(r) => {
                for rec in r.into_iter_err_on_gc_types() {
                    types.push(rec.map_err(pe)?);
                }
            }
            Payload::ImportSection(r) => {
                for i in r {
                    let i = i.map_err(pe)?;
                    if matches!(i.ty, TypeRef::Func(_)) {
                        imported_funcs += 1;
                    }
                    imports.push((i.module.to_string(), i.name.to_string(), i.ty));
                }
            }
            Payload::FunctionSection(r) => {
                for f in r {
                    func_type_idx.push(f.map_err(pe)?);
                }
            }
            Payload::TableSection(r) => {
                for t in r {
                    tables.push(t.map_err(pe)?.ty);
                }
            }
            Payload::MemorySection(r) => {
                for m in r {
                    memories.push(m.map_err(pe)?);
                }
            }
            Payload::GlobalSection(r) => globals += r.count(),
            Payload::ExportSection(r) => {
                for e in r {
                    let e = e.map_err(pe)?;
                    exports.push((e.name.to_string(), e.kind, e.index));
                }
            }
            Payload::StartSection { .. } => has_start = true,
            Payload::DataSection(r) => {
                for d in r {
                    data_bytes = data_bytes.saturating_add(d.map_err(pe)?.data.len());
                }
            }
            Payload::CodeSectionEntry(body) => {
                let mut n = 0u32;
                for l in body.get_locals_reader().map_err(pe)? {
                    n = n.saturating_add(l.map_err(pe)?.0);
                }
                max_locals = max_locals.max(n);
            }
            Payload::CustomSection(c) => customs.push((c.name().to_string(), c.data().to_vec())),
            _ => {}
        }
    }
    if has_start {
        return Err(AdmissionError::new("ADM_FEATURE_DISALLOWED", "start function"));
    }

    // A4: every import is one of the seven, with exactly that signature; no imported memories, tables or globals.
    for (module, name, ty) in &imports {
        let TypeRef::Func(ti) = ty else {
            return Err(AdmissionError::new("ADM_IMPORT_DISALLOWED", format!("{module}.{name}: only functions may be imported")));
        };
        let ok = module == "notary_v1"
            && ABI_IMPORTS.iter().any(|(n, p, r)| n == name && types.get(*ti as usize).is_some_and(|t| is_abi_signature(t, *p, *r)));
        if !ok {
            return Err(AdmissionError::new("ADM_IMPORT_DISALLOWED", format!("{module}.{name}")));
        }
    }

    // A5: exactly one defined memory, not shared, exported as "memory", maximum ≤ 256 pages and ≤ limits.memory_pages.
    let limits = check_limits(notary);
    let policy_pages = notary.pointer("/limits/memory_pages").and_then(Value::as_u64).unwrap_or(MAX_MEMORY_PAGES);
    match memories.as_slice() {
        [m] if !m.shared && !m.memory64 => match m.maximum {
            Some(max) if max <= MAX_MEMORY_PAGES && max <= policy_pages => {}
            Some(max) => return Err(AdmissionError::new("ADM_MEMORY_LIMIT", format!("maximum {max} pages"))),
            None => return Err(AdmissionError::new("ADM_MEMORY_LIMIT", "memory has no declared maximum")),
        },
        _ => return Err(AdmissionError::new("ADM_MEMORY_LIMIT", "exactly one unshared 32-bit memory is required")),
    }

    // A6: at most one table, funcref, declared maximum ≤ 1,024.
    match tables.as_slice() {
        [] => {}
        [t] if t.element_type == wasmparser::RefType::FUNCREF => match t.maximum {
            Some(max) if max <= MAX_TABLE_ELEMENTS => {}
            _ => return Err(AdmissionError::new("ADM_TABLE_LIMIT", "table maximum missing or above 1,024")),
        },
        _ => return Err(AdmissionError::new("ADM_TABLE_LIMIT", "at most one funcref table")),
    }

    // A7: structure limits.
    let funcs = imported_funcs as usize + func_type_idx.len();
    if funcs > MAX_FUNCTIONS as usize || max_locals > MAX_LOCALS_PER_FUNCTION || globals > MAX_GLOBALS || data_bytes > MAX_DATA_BYTES {
        return Err(AdmissionError::new(
            "ADM_STRUCTURE_LIMIT",
            format!("functions {funcs}, max locals {max_locals}, globals {globals}, data bytes {data_bytes}"),
        ));
    }

    // A8: exactly two exports, "memory" and "run": () -> i32.
    let run_ok = exports.iter().any(|(n, k, i)| {
        n == "run"
            && *k == ExternalKind::Func
            && i.checked_sub(imported_funcs)
                .and_then(|d| func_type_idx.get(d as usize))
                .and_then(|t| types.get(*t as usize))
                .is_some_and(|t| t.params().is_empty() && t.results() == [ValType::I32])
    });
    let mem_ok = exports.iter().any(|(n, k, _)| n == "memory" && *k == ExternalKind::Memory);
    if exports.len() != 2 || !run_ok || !mem_ok {
        return Err(AdmissionError::new("ADM_EXPORTS_INVALID", "exports must be exactly \"memory\" and \"run\": () -> i32"));
    }

    // A9: notary.abi = "notary_v1"; notary.output_schema = canonical policy output_schema; each exactly once.
    let once = |name: &str| -> Result<&Vec<u8>, AdmissionError> {
        let found: Vec<&Vec<u8>> = customs.iter().filter(|(n, _)| n == name).map(|(_, d)| d).collect();
        match found.as_slice() {
            [d] => Ok(*d),
            _ => Err(AdmissionError::new("ADM_SCHEMA_MISMATCH", format!("custom section {name} must appear exactly once"))),
        }
    };
    if once("notary.abi")? != ABI_VERSION.as_bytes() {
        return Err(AdmissionError::new("ADM_SCHEMA_MISMATCH", "notary.abi is not notary_v1"));
    }
    let schema = notary.get("output_schema").ok_or_else(|| AdmissionError::new("ADM_SCHEMA_MISMATCH", "policy has no output_schema"))?;
    let canonical = jcs::canonical(schema).map_err(|e| AdmissionError::new("ADM_SCHEMA_MISMATCH", e.message))?;
    if *once("notary.output_schema")? != canonical {
        return Err(AdmissionError::new("ADM_SCHEMA_MISMATCH", "notary.output_schema differs from the policy's output_schema"));
    }

    // A10: limits within the runtime ceilings.
    let limits = limits?;

    // A11: shared needs the allowlist; dedicated needs an otherwise empty runtime.
    let isolation = match notary.get("isolation").and_then(Value::as_str) {
        Some("shared") => {
            if let Some(list) = ctx.allowlist {
                let ok = list.iter().any(|e| {
                    e.program_cid == cid && e.accepted_from_ms <= ctx.now_ms && e.retired_at_ms.is_none_or(|r| ctx.now_ms < r)
                });
                if !ok {
                    return Err(AdmissionError::new("ADM_NOT_ALLOWLISTED_FOR_SHARED", cid.to_string()));
                }
            }
            Isolation::Shared
        }
        Some("dedicated") => {
            if ctx.held_jobs > 0 {
                return Err(AdmissionError::new("ADM_DEDICATED_REQUIRED", format!("runtime already holds {} job(s)", ctx.held_jobs)));
            }
            Isolation::Dedicated
        }
        _ => return Err(AdmissionError::new("ADM_DEDICATED_REQUIRED", "isolation must be shared or dedicated")),
    };

    Ok(Admitted { program_hash, limits, isolation })
}

/// `notary-lint` warnings (runtime §6). Non-fatal.
pub fn lint_warnings(notary: &Value) -> Vec<&'static str> {
    let mut w = Vec::new();
    let k_min = notary.pointer("/privacy/k_min").and_then(Value::as_u64).unwrap_or(0);
    let weak = notary.get("output_schema").and_then(Value::as_array).is_some_and(|fields| {
        fields.iter().any(|f| {
            f.get("type").and_then(Value::as_str) == Some("integer") && f.get("round_to").is_none() && f.get("buckets").is_none()
        })
    });
    if weak && k_min < 10 {
        w.push("LINT_WEAK_GRANULARITY");
    }
    fn names_policy(v: &Value) -> bool {
        match v {
            Value::Object(m) => m.contains_key("issued_under_template") || m.values().any(names_policy),
            Value::Array(a) => a.iter().any(names_policy),
            _ => false,
        }
    }
    if !notary.get("contributor_predicate").is_some_and(names_policy) {
        w.push("LINT_NO_SNAPSHOT_POLICY");
    }
    w
}
