//! Algorithm V steps V6–V12, shared by every platform (notary_lifecycle.md A.1, protocol-objects.md §33).
//! Works on the parsed `Envelope`; never sees the document format (G5).
//!
//! Also the front door `verify_attestation`, which picks the platform module and raises
//! `ATT_PLATFORM_NOT_ALLOWED` (interface note Q15) before any parsing happens.
use crate::{aws::AwsVerifier, sim::SimVerifier, AttestationVerifier, Envelope};
use notary_types::user_data::UserData;
use std::collections::BTreeMap;

/// One entry of the accepted-runtime list (§34), already verified by algorithm L.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcceptedRuntime {
    pub pcr0: Vec<u8>,
    pub platform: String,
    pub accepted_from_ms: i64,
    pub retired_at_ms: Option<i64>,
    pub retire_reason: Option<RetireReason>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetireReason {
    Superseded,
    Vulnerable,
}

/// What the verifier expects the document to bind (protocol-objects.md §33). Unused fields are zero.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Expected {
    pub user_data: UserData,
    /// `None` means the document must carry no nonce / public key.
    pub nonce: Option<Vec<u8>>,
    pub public_key: Option<Vec<u8>>,
}

#[derive(Debug, Clone)]
pub struct Context<'a> {
    /// The chain time at which PCR0 must be accepted.
    pub t_eval_ms: i64,
    pub now_ms: i64,
    pub max_age_ms: Option<i64>,
    pub accepted_runtimes: &'a [AcceptedRuntime],
    pub platform: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verified {
    pub measurement: Vec<u8>,
    pub timestamp_ms: u64,
    /// e.g. `runtime_retired_vulnerable`.
    pub warnings: Vec<&'static str>,
}

const FUTURE_SKEW_MS: i64 = 5 * 60 * 1000;

/// V6–V12 over a parsed envelope. Returns the first failing `ATT_*` code.
pub fn verify_parsed(env: &Envelope, expected: &Expected, ctx: &Context<'_>) -> Result<Verified, &'static str> {
    // V6: debug mode
    if (0..=2).all(|i| env.pcrs.get(&i).is_some_and(|p| p.iter().all(|b| *b == 0))) {
        return Err("ATT_DEBUG_MODE");
    }
    // V7: PCR0 accepted at t_eval
    let mut warnings = Vec::new();
    let hit = ctx.accepted_runtimes.iter().find(|r| {
        r.pcr0 == env.measurement
            && r.platform == ctx.platform
            && r.accepted_from_ms <= ctx.t_eval_ms
            && r.retired_at_ms.is_none_or(|t| ctx.t_eval_ms < t)
    });
    match hit {
        None => return Err("ATT_RUNTIME_NOT_ACCEPTED"),
        Some(r) if r.retire_reason == Some(RetireReason::Vulnerable) => warnings.push("runtime_retired_vulnerable"),
        Some(_) => {}
    }
    // V8: user_data layout
    let ud = UserData::decode(&env.user_data).map_err(|_| "ATT_USER_DATA_MALFORMED")?;
    // V9: purpose
    if ud.purpose != expected.user_data.purpose {
        return Err("ATT_PURPOSE_MISMATCH");
    }
    // V10: every bound field equals the expected value, every unused field is zero
    if ud != expected.user_data {
        return Err("ATT_BINDING_MISMATCH");
    }
    // V11: nonce and public_key
    if env.nonce != expected.nonce {
        return Err("ATT_NONCE_MISMATCH");
    }
    if env.public_key != expected.public_key {
        return Err("ATT_KEY_MISMATCH");
    }
    // V12: freshness
    if let Some(max_age) = ctx.max_age_ms {
        let ts = i64::try_from(env.timestamp_ms).map_err(|_| "ATT_STALE")?;
        if ts < ctx.now_ms - max_age || ts > ctx.now_ms + FUTURE_SKEW_MS {
            return Err("ATT_STALE");
        }
    }
    Ok(Verified { measurement: env.measurement.clone(), timestamp_ms: env.timestamp_ms, warnings })
}

/// Pinned trust roots and platform policy (notary_runtime.md §5, wallet `NotaryConfig`).
#[derive(Debug, Clone, Default)]
pub struct Config {
    pub roots: BTreeMap<String, Vec<u8>>,
    pub allow_simulator: bool,
}

/// Full algorithm V for one document: platform gate, V1–V5 (platform module), V6–V12 (shared).
pub fn verify_attestation(doc: &[u8], cfg: &Config, expected: &Expected, ctx: &Context<'_>) -> Result<Verified, &'static str> {
    let module: Box<dyn AttestationVerifier> = match ctx.platform {
        "aws-nitro-enclaves" => Box::new(AwsVerifier),
        "simulator" if cfg.allow_simulator => Box::new(SimVerifier),
        _ => return Err("ATT_PLATFORM_NOT_ALLOWED"),
    };
    let root = cfg.roots.get(ctx.platform).ok_or("ATT_PLATFORM_NOT_ALLOWED")?;
    let env = module.verify_envelope(doc, root).map_err(|c| c.code())?;
    verify_parsed(&env, expected, ctx)
}
