//! notary-worker — runs one admitted `notary_v1` program.
//!
//! Implements:
//! - notary_runtime.md §3 (one fresh wasmi store and instance per run, so no program state carries over);
//! - §6 (the engine refuses every feature §6 rejects, as defence in depth behind algorithm A);
//! - §7 (the `notary_v1` ABI: seven imports, all `i32`; the frozen fuel table);
//! - §8 (`run` / `output` / `error` semantics; the framing lives in `protocol`);
//! - §14 (fuel and memory ceilings; the wall-clock limit is enforced by the broker, which kills the worker).
//!
//! **CP9 checkpoint 4 (runtime §17).** wasmi is pinned to exactly 2.0.0. The fuel table is set explicitly
//! (`frozen_operator_cost`, `FROZEN_DYNAMIC_COSTS`), compilation is eager (no fuel is charged for lazy translation),
//! and `tests/cp9.rs` proves (a) every §6-rejected feature is refused by this engine and (b) a fixed corpus consumes
//! exactly the fuel recorded in `notary/vectors/fuel/corpus.json`, in debug and release builds and under both
//! interpreter dispatch modes. A runtime that changes any of this must use a new ABI string.
pub mod protocol;

use sha2::{Digest, Sha256};
use wasmi::{
    CompilationMode, Config, CustomFuelCosts, Engine, Linker, Memory, Module, OperatorCost, Store, StoreLimits,
    StoreLimitsBuilder, TrapCode,
};

/// The ABI string programs must carry in their `notary.abi` custom section (runtime §6 A9, §7).
pub const ABI_VERSION: &str = "notary_v1";
/// The import module name of every ABI function (runtime §7).
pub const ABI_MODULE: &str = "notary_v1";

/// Runtime ceilings (runtime §14). Provisional until the capacity benchmark (step 5.6).
pub const MAX_FUEL: u64 = 1_000_000_000;
pub const MAX_WALL_MS: u64 = 60_000;
pub const MAX_MEMORY_PAGES: u32 = 256;
pub const WASM_PAGE: usize = 65_536;

/// Dynamic fuel costs of `notary_v1`. Frozen: changing any value requires a new ABI string.
pub const FROZEN_DYNAMIC_COSTS: CustomFuelCosts =
    CustomFuelCosts { bytes_copied_per_fuel: 64, fuel_per_bytes_translated: 7, fuel_per_bytes_validated: 2 };

/// Per-operator fuel costs of `notary_v1`: 1 per operator, except `unreachable`, `return`, `else` and `end`, which
/// cost 0 (wasmi 2.0.0's table). The table is pinned by `tests/cp9.rs::operator_table_is_frozen`, which hashes every
/// entry, so a wasmi upgrade that changed it would fail the build's tests rather than silently change fuel.
pub fn frozen_operator_cost() -> OperatorCost {
    OperatorCost::default()
}

/// The `notary_v1` engine configuration (runtime §6, §7).
///
/// Allowed: WebAssembly 1.0 plus `mutable-global`, `sign-extension`, `multi-value` and `bulk-memory`.
/// Disabled here: floats (all `f32`/`f64` types and instructions, including saturating conversions), SIMD and relaxed
/// SIMD (the `simd` cargo feature is also off), reference types, tail calls, extended constants, multi-memory,
/// custom page sizes, wide arithmetic, `memory64` (cargo feature off), and start functions. Threads, atomics, shared
/// memory, exceptions, GC and the component model are not implemented by wasmi 2.0.0 and fail validation.
pub fn engine_config() -> Config {
    let mut c = Config::default();
    c.wasm_mutable_global(true)
        .wasm_sign_extension(true)
        .wasm_multi_value(true)
        .wasm_bulk_memory(true)
        .wasm_saturating_float_to_int(false)
        .wasm_reference_types(false)
        .wasm_tail_call(false)
        .wasm_extended_const(false)
        .wasm_multi_memory(false)
        .wasm_custom_page_sizes(false)
        .wasm_wide_arithmetic(false)
        .floats(false)
        .allow_start_fn(false)
        .consume_fuel(true)
        .operator_cost(frozen_operator_cost())
        .fuel_cost(FROZEN_DYNAMIC_COSTS)
        .compilation_mode(CompilationMode::Eager);
    c
}

pub fn engine() -> Engine {
    Engine::new(&engine_config())
}

/// Limits for one run, already within the runtime ceilings (A10 checks policy limits at admission).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunLimits {
    pub fuel: u64,
    pub memory_pages: u32,
}

impl Default for RunLimits {
    fn default() -> Self {
        Self { fuel: MAX_FUEL, memory_pages: MAX_MEMORY_PAGES }
    }
}

/// The reasons a run can fail (runtime §8, `error.reason`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunError {
    Trap,
    Fuel,
    Memory,
    Abort(i32),
    OutputTwice,
    NoOutput,
}

impl RunError {
    /// The `reason` string sent to the broker.
    pub fn reason(&self) -> String {
        match self {
            Self::Trap => "trap".into(),
            Self::Fuel => "fuel".into(),
            Self::Memory => "memory".into(),
            Self::Abort(c) => format!("abort:{c}"),
            Self::OutputTwice => "output_twice".into(),
            Self::NoOutput => "no_output".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunOutput {
    pub bytes: Vec<u8>,
    pub fuel_used: u64,
}

/// A compiled program, bound to the hash of its bytes (the worker reports this hash in `loaded`).
pub struct Program {
    engine: Engine,
    module: Module,
    pub program_hash: [u8; 32],
}

impl Program {
    /// Compiles a program. Fails if the bytes don't validate under the `notary_v1` engine.
    pub fn load(bytes: &[u8]) -> Result<Self, String> {
        let engine = engine();
        let module = Module::new(&engine, bytes).map_err(|e| e.to_string())?;
        Ok(Self { engine, module, program_hash: Sha256::digest(bytes).into() })
    }

    /// One run: a fresh store and instance, the inputs in the order given (the broker sorts by `input_hash`).
    pub fn run(&self, params: &[u8], inputs: &[Vec<u8>], limits: RunLimits) -> Result<RunOutput, RunError> {
        run_module(&self.engine, &self.module, params, inputs, limits)
    }
}

struct Ctx<'a> {
    params: &'a [u8],
    inputs: &'a [Vec<u8>],
    output: Option<Vec<u8>>,
    failure: Option<RunError>,
    memory: Option<Memory>,
    limits: StoreLimits,
}

fn host_fail<T>(caller: &mut wasmi::Caller<'_, Ctx<'_>>, e: RunError) -> Result<T, wasmi::Error> {
    caller.data_mut().failure = Some(e);
    Err(wasmi::Error::i32_exit(-1))
}

fn mem(caller: &wasmi::Caller<'_, Ctx<'_>>) -> Option<Memory> {
    caller.data().memory
}

#[derive(Clone, Copy)]
enum Src {
    Input(usize),
    Params,
}

/// Copy a payload into guest memory at `ptr`, at most `len` bytes. Traps if the destination range is out of bounds.
fn copy_out(caller: &mut wasmi::Caller<'_, Ctx<'_>>, src: Src, ptr: i32, len: i32) -> Result<i32, wasmi::Error> {
    if ptr < 0 || len < 0 {
        return host_fail(caller, RunError::Trap);
    }
    let Some(m) = mem(caller) else { return host_fail(caller, RunError::Trap) };
    let (data, ctx) = m.data_and_store_mut(&mut *caller);
    let payload: &[u8] = match src {
        Src::Input(i) => &ctx.inputs[i],
        Src::Params => ctx.params,
    };
    let n = payload.len().min(len as usize);
    let start = ptr as usize;
    match start.checked_add(n) {
        Some(end) if end <= data.len() => {
            data[start..end].copy_from_slice(&payload[..n]);
            Ok(n as i32)
        }
        _ => {
            ctx.failure = Some(RunError::Trap);
            Err(wasmi::Error::i32_exit(-1))
        }
    }
}

fn run_module(engine: &Engine, module: &Module, params: &[u8], inputs: &[Vec<u8>], limits: RunLimits) -> Result<RunOutput, RunError> {
    let store_limits = StoreLimitsBuilder::new()
        .memory_size(limits.memory_pages as usize * WASM_PAGE)
        .memories(1)
        .tables(1)
        .table_elements(1024)
        .instances(1)
        .trap_on_grow_failure(true)
        .build();
    let ctx = Ctx { params, inputs, output: None, failure: None, memory: None, limits: store_limits };
    let mut store = Store::new(engine, ctx);
    store.limiter(|c| &mut c.limits);
    store.set_fuel(limits.fuel).map_err(|_| RunError::Trap)?;

    let mut linker: Linker<Ctx<'_>> = Linker::new(engine);
    let m = ABI_MODULE;
    linker
        .func_wrap(m, "input_count", |c: wasmi::Caller<'_, Ctx<'_>>| -> i32 { c.data().inputs.len() as i32 })
        .and_then(|l| {
            l.func_wrap(m, "input_len", |mut c: wasmi::Caller<'_, Ctx<'_>>, i: i32| -> Result<i32, wasmi::Error> {
                match usize::try_from(i).ok().and_then(|i| c.data().inputs.get(i)) {
                    Some(x) => Ok(x.len() as i32),
                    None => host_fail(&mut c, RunError::Trap),
                }
            })
        })
        .and_then(|l| {
            l.func_wrap(m, "input_read", |mut c: wasmi::Caller<'_, Ctx<'_>>, i: i32, ptr: i32, len: i32| -> Result<i32, wasmi::Error> {
                let Some(idx) = usize::try_from(i).ok().filter(|i| *i < c.data().inputs.len()) else {
                    return host_fail(&mut c, RunError::Trap);
                };
                copy_out(&mut c, Src::Input(idx), ptr, len)
            })
        })
        .and_then(|l| l.func_wrap(m, "param_len", |c: wasmi::Caller<'_, Ctx<'_>>| -> i32 { c.data().params.len() as i32 }))
        .and_then(|l| {
            l.func_wrap(m, "param_read", |mut c: wasmi::Caller<'_, Ctx<'_>>, ptr: i32, len: i32| -> Result<i32, wasmi::Error> {
                copy_out(&mut c, Src::Params, ptr, len)
            })
        })
        .and_then(|l| {
            l.func_wrap(m, "output_write", |mut c: wasmi::Caller<'_, Ctx<'_>>, ptr: i32, len: i32| -> Result<i32, wasmi::Error> {
                if c.data().output.is_some() {
                    return host_fail(&mut c, RunError::OutputTwice);
                }
                if ptr < 0 || len < 0 {
                    return host_fail(&mut c, RunError::Trap);
                }
                let Some(mm) = mem(&c) else { return host_fail(&mut c, RunError::Trap) };
                let data = mm.data(&c);
                let (s, n) = (ptr as usize, len as usize);
                let Some(bytes) = s.checked_add(n).filter(|e| *e <= data.len()).map(|e| data[s..e].to_vec()) else {
                    return host_fail(&mut c, RunError::Trap);
                };
                c.data_mut().output = Some(bytes);
                Ok(len)
            })
        })
        .and_then(|l| {
            l.func_wrap(m, "abort", |mut c: wasmi::Caller<'_, Ctx<'_>>, code: i32| -> Result<(), wasmi::Error> {
                host_fail(&mut c, RunError::Abort(code))
            })
        })
        .map_err(|_| RunError::Trap)?;

    let instance = match linker.instantiate_and_start(&mut store, module) {
        Ok(i) => i,
        Err(e) => return Err(classify(&e, store.data().failure.clone())),
    };
    let memory = instance.get_memory(&store, "memory").ok_or(RunError::Trap)?;
    store.data_mut().memory = Some(memory);
    let run = instance.get_typed_func::<(), i32>(&store, "run").map_err(|_| RunError::Trap)?;
    let result = run.call(&mut store, ());
    let fuel_used = limits.fuel - store.get_fuel().unwrap_or(0);
    let data = store.into_data();
    match result {
        Err(e) => Err(classify(&e, data.failure)),
        Ok(_) => match data.output {
            Some(bytes) => Ok(RunOutput { bytes, fuel_used }),
            None => Err(RunError::NoOutput),
        },
    }
}

fn classify(e: &wasmi::Error, host: Option<RunError>) -> RunError {
    if let Some(h) = host {
        return h;
    }
    match e.as_trap_code() {
        Some(TrapCode::OutOfFuel) => RunError::Fuel,
        Some(TrapCode::GrowthOperationLimited) => RunError::Memory,
        _ => {
            // Instantiation fails with a non-trap error when the initial memory exceeds the store limit.
            let msg = e.to_string();
            if msg.contains("memory") && (msg.contains("limit") || msg.contains("grow")) { RunError::Memory } else { RunError::Trap }
        }
    }
}
