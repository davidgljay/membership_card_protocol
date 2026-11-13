//! Worker isolation (notary_runtime.md §3): own UID, rlimits, seccomp-bpf. Linux only; elsewhere `enter` reports that
//! no sandbox was applied (development on macOS; the isolation tests run in the Linux container).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub struct WorkerLimits {
    pub uid: Option<u32>,
    pub memory_bytes: u64,
    pub cpu_seconds: u64,
}

#[cfg(target_os = "linux")]
pub fn enter(l: &WorkerLimits) -> Result<(), String> {
    use nix::sys::resource::{setrlimit, Resource};
    use seccompiler::{apply_filter, BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter, SeccompRule};
    use std::collections::BTreeMap;

    // 1. UID: drop from root to the worker's own UID (and GID) if asked.
    if let Some(uid) = l.uid {
        if nix::unistd::geteuid().is_root() {
            nix::unistd::setgroups(&[]).map_err(|e| format!("setgroups: {e}"))?;
            nix::unistd::setgid(nix::unistd::Gid::from_raw(uid)).map_err(|e| format!("setgid: {e}"))?;
            nix::unistd::setuid(nix::unistd::Uid::from_raw(uid)).map_err(|e| format!("setuid: {e}"))?;
        }
    }
    // 2. rlimits: address space, CPU time, no core dumps, no new files.
    setrlimit(Resource::RLIMIT_AS, l.memory_bytes, l.memory_bytes).map_err(|e| format!("RLIMIT_AS: {e}"))?;
    setrlimit(Resource::RLIMIT_CPU, l.cpu_seconds, l.cpu_seconds).map_err(|e| format!("RLIMIT_CPU: {e}"))?;
    setrlimit(Resource::RLIMIT_CORE, 0, 0).map_err(|e| format!("RLIMIT_CORE: {e}"))?;
    setrlimit(Resource::RLIMIT_NOFILE, 3, 3).map_err(|e| format!("RLIMIT_NOFILE: {e}"))?;

    // 3. seccomp, exactly the runtime §3 list: read on fd 0 and write on fd 1 (the two pipes), exit_group,
    //    mmap/munmap/brk, futex. Anything else kills the process.
    let fd_is = |fd: u64| SeccompRule::new(vec![SeccompCondition::new(0, SeccompCmpArgLen::Qword, SeccompCmpOp::Eq, fd).unwrap()]).unwrap();
    let mut rules: BTreeMap<i64, Vec<SeccompRule>> = BTreeMap::new();
    rules.insert(libc_nr::READ, vec![fd_is(0)]);
    rules.insert(libc_nr::WRITE, vec![fd_is(1)]);
    for nr in libc_nr::ALWAYS {
        rules.insert(*nr, vec![]);
    }
    let arch = if cfg!(target_arch = "aarch64") { seccompiler::TargetArch::aarch64 } else { seccompiler::TargetArch::x86_64 };
    let filter = SeccompFilter::new(rules, SeccompAction::KillProcess, SeccompAction::Allow, arch).map_err(|e| format!("seccomp: {e}"))?;
    let prog: BpfProgram = filter.try_into().map_err(|e| format!("seccomp: {e:?}"))?;
    apply_filter(&prog).map_err(|e| format!("seccomp: {e}"))?;
    Ok(())
}

#[cfg(target_os = "linux")]
mod libc_nr {
    // Syscall numbers (asm-generic on aarch64, x86_64 table otherwise).
    #[cfg(target_arch = "aarch64")]
    pub const READ: i64 = 63;
    #[cfg(target_arch = "aarch64")]
    pub const WRITE: i64 = 64;
    /// exit_group, mmap, munmap, brk, futex.
    #[cfg(target_arch = "aarch64")]
    pub const ALWAYS: &[i64] = &[94, 222, 215, 214, 98];
    #[cfg(target_arch = "x86_64")]
    pub const READ: i64 = 0;
    #[cfg(target_arch = "x86_64")]
    pub const WRITE: i64 = 1;
    #[cfg(target_arch = "x86_64")]
    pub const ALWAYS: &[i64] = &[231, 9, 11, 12, 202];
}

/// Ends the worker with `exit_group` directly. Rust's normal exit path tears down the signal stack with
/// `sigaltstack`, which the filter does not allow; `_exit` skips that cleanup (there is nothing to flush: replies are
/// written and flushed frame by frame).
#[cfg(target_os = "linux")]
pub fn exit(code: i32) -> ! {
    // SAFETY: `_exit` takes no pointers and never returns.
    unsafe { libc::_exit(code) }
}

#[cfg(not(target_os = "linux"))]
pub fn exit(code: i32) -> ! {
    std::process::exit(code)
}

#[cfg(not(target_os = "linux"))]
pub fn enter(_l: &WorkerLimits) -> Result<(), String> {
    if std::env::var("NOTARY_REQUIRE_SANDBOX").is_ok() {
        return Err("worker isolation needs Linux (seccomp, UIDs, rlimits)".into());
    }
    Ok(())
}
