//! Governance lists inside the runtime (notary_runtime.md §12; algorithm L, notary_lifecycle.md Appendix A.5;
//! protocol-objects.md §34).
//!
//! The image pins the two list-card addresses, the PressRegistryBody member keyset and a version floor per list. The
//! host supplies list versions; the broker accepts a version only if algorithm L passes against the pinned keyset, and
//! never goes below the floor or below the highest version it has seen (`LIST_VERSION_REGRESSION`).
//!
//! Twin of `membership_card_verifier/packages/verifier/src/notary/lists.ts`. Both are judged against
//! `notary/vectors/lists/cases.json` (written by this crate's tests).
//! Signed message (E6, E12): the 32 raw bytes of H(JCS(approval without "signatures")); scheme 0 is ECDSA secp256r1
//! with that digest used as the message hash, scheme 1 is ML-DSA-44 over the 32 bytes.
use notary_attest::verify::{AcceptedRuntime, RetireReason};
use notary_types::{b64u, formats, jcs};
use serde_json::Value;

/// Protocol constant (protocol-objects.md §34).
pub const EMERGENCY_RETIREMENT_THRESHOLD: usize = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Keyset {
    /// scheme 0: 64-byte x‖y; scheme 1: 1312-byte ML-DSA-44 public keys.
    pub keys: Vec<Vec<u8>>,
    pub quorum: usize,
    pub version: u32,
    pub key_scheme: u8,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ListVersion {
    pub value: Value,
    pub approval_text: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListKind {
    AcceptedRuntimes,
    ProgramAllowlist,
}

impl ListKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::AcceptedRuntimes => "accepted_runtimes",
            Self::ProgramAllowlist => "program_allowlist",
        }
    }
    fn key_field(self) -> &'static str {
        match self {
            Self::AcceptedRuntimes => "pcr0",
            Self::ProgramAllowlist => "program_cid",
        }
    }
}

pub fn verify_member_signature(scheme: u8, public_key: &[u8], digest: &[u8; 32], signature: &[u8]) -> bool {
    match scheme {
        0 => notary_crypto::p256_verify_digest(public_key, digest, signature),
        1 => notary_crypto::mldsa_verify(public_key, digest, signature),
        _ => false,
    }
}

pub fn approval_digest(approval: &Value) -> Option<[u8; 32]> {
    jcs::h_bytes(&jcs::without_fields(approval, &["signatures"])).ok()
}

fn h(v: &Value) -> Option<String> {
    jcs::h(v).ok()
}

/// Rule E (§34): removal-only change.
pub fn is_removal_only(prev: &Value, next: &Value, field: &str) -> bool {
    let (Some(a), Some(b)) = (prev.as_array(), next.as_array()) else { return false };
    if a.len() != b.len() {
        return false;
    }
    let mut changed = 0;
    for (x, y) in a.iter().zip(b) {
        if x.get(field) != y.get(field) {
            return false;
        }
        let strip = |v: &Value| h(&jcs::without_fields(v, &["retire_reason", "retired_at"]));
        if strip(x).is_none() || strip(x) != strip(y) {
            return false;
        }
        if h(x) == h(y) {
            continue;
        }
        if y.get("retire_reason").and_then(Value::as_str) != Some("vulnerable") {
            return false;
        }
        let Some(after) = y.get("retired_at").and_then(Value::as_str).and_then(|s| formats::parse_timestamp(s).ok()) else {
            return false;
        };
        if let Some(before) = x.get("retired_at") {
            match before.as_str().and_then(|s| formats::parse_timestamp(s).ok()) {
                Some(b) if after < b => {}
                _ => return false,
            }
        }
        changed += 1;
    }
    changed >= 1
}

struct Approval {
    v: Value,
    list_version: u64,
    kind: String,
    /// `single_operator_quorums`, normalized: absent is "allowed".
    switch: String,
}

fn parse_approval(text: Option<&str>, list: ListKind, list_card: &str) -> Result<Approval, &'static str> {
    let text = text.ok_or("LIST_APPROVAL_MISSING")?;
    let v = jcs::parse_canonical(text.as_bytes()).map_err(|_| "LIST_APPROVAL_MALFORMED")?;
    let a: notary_types::objects::ListApproval =
        notary_types::objects::from_value(&v, notary_types::objects::types::LIST_APPROVAL).map_err(|_| "LIST_APPROVAL_MALFORMED")?;
    if a.list != list.name() || a.list_card != list_card || a.list_version < 1 || !["standard", "emergency_retirement"].contains(&a.kind.as_str()) {
        return Err("LIST_APPROVAL_MALFORMED");
    }
    if let Some(sw) = &a.single_operator_quorums {
        if list != ListKind::ProgramAllowlist || !["allowed", "refused"].contains(&sw.as_str()) {
            return Err("LIST_APPROVAL_MALFORMED");
        }
    }
    let switch = a.single_operator_quorums.unwrap_or_else(|| "allowed".into());
    Ok(Approval { list_version: a.list_version, kind: a.kind, v, switch })
}

/// What algorithm L accepts: the head list, its `list_version`, and (program allowlist) `single_operator_quorums`.
#[derive(Debug, Clone, PartialEq)]
pub struct Verified {
    pub value: Value,
    pub version: u64,
    pub single_operator_quorums_refused: bool,
}

/// Algorithm L steps 1–5. `history` is oldest first, head last.
pub fn verify_list_approval(list: ListKind, list_card: &str, history: &[ListVersion], k: &Keyset) -> Result<Verified, &'static str> {
    let mut head_version = 0;
    let mut head_refused = false;
    for idx in (0..history.len()).rev() {
        let ver = &history[idx];
        let prev = idx.checked_sub(1).map(|i| &history[i]);
        // 1
        let a = parse_approval(ver.approval_text.as_deref(), list, list_card)?;
        if idx == history.len() - 1 {
            head_version = a.list_version;
            head_refused = a.switch == "refused";
        }
        // 2
        if a.v.get("list_hash").and_then(Value::as_str) != h(&ver.value).as_deref() {
            return Err("LIST_APPROVAL_HASH_MISMATCH");
        }
        if a.list_version > 1 {
            let prev = prev.ok_or("LIST_APPROVAL_HASH_MISMATCH")?;
            let pa = parse_approval(prev.approval_text.as_deref(), list, list_card).map_err(|_| "LIST_APPROVAL_HASH_MISMATCH")?;
            if a.v.get("prev_list_hash").and_then(Value::as_str) != h(&prev.value).as_deref() || pa.list_version + 1 != a.list_version {
                return Err("LIST_APPROVAL_HASH_MISMATCH");
            }
        } else if a.v.get("prev_list_hash").is_some() {
            return Err("LIST_APPROVAL_HASH_MISMATCH");
        }
        // 3
        if a.v.get("governance_version").and_then(Value::as_u64) != Some(k.version as u64) {
            return Err("LIST_APPROVAL_KEYSET_STALE");
        }
        // 4
        let digest = approval_digest(&a.v).ok_or("LIST_APPROVAL_MALFORMED")?;
        let mut signers = std::collections::BTreeSet::new();
        for s in a.v["signatures"].as_array().into_iter().flatten() {
            let Some(i) = s.get("key_index").and_then(Value::as_u64).map(|i| i as usize).filter(|i| *i < k.keys.len()) else { continue };
            let Some(sig) = s.get("signature").and_then(Value::as_str).and_then(|x| b64u::decode(x).ok()) else { continue };
            if verify_member_signature(k.key_scheme, &k.keys[i], &digest, &sig) {
                signers.insert(i);
            }
        }
        let need = if a.kind == "standard" { k.quorum } else { EMERGENCY_RETIREMENT_THRESHOLD };
        if signers.len() < need {
            return Err("LIST_APPROVAL_THRESHOLD");
        }
        if a.kind == "standard" {
            return Ok(Verified { value: history[history.len() - 1].value.clone(), version: head_version, single_operator_quorums_refused: head_refused });
        }
        // 5: removal-only, with the same single_operator_quorums as the previous version (rule E)
        match prev {
            Some(p) if is_removal_only(&p.value, &ver.value, list.key_field()) => {
                if let Ok(pa) = parse_approval(p.approval_text.as_deref(), list, list_card) {
                    if pa.switch != a.switch {
                        return Err("LIST_APPROVAL_NOT_REMOVAL_ONLY");
                    }
                }
            }
            _ => return Err("LIST_APPROVAL_NOT_REMOVAL_ONLY"),
        }
    }
    Err("LIST_APPROVAL_MISSING")
}

/// What the image pins (runtime §12, step 1).
#[derive(Debug, Clone)]
pub struct Pins {
    pub accepted_runtimes_card: String,
    pub program_allowlist_card: String,
    pub keyset: Keyset,
    pub accepted_runtimes_floor: u64,
    pub program_allowlist_floor: u64,
}

/// The runtime's verified copies of both lists.
#[derive(Debug, Clone)]
pub struct Lists {
    pub pins: Pins,
    pub runtimes: Option<(Value, u64)>,
    pub programs: Option<(Value, u64)>,
    /// From the verified program allowlist head (§34). False until a list is verified (the bootstrap default).
    pub single_operator_quorums_refused: bool,
}

impl Lists {
    pub fn new(pins: Pins) -> Self {
        Self { pins, runtimes: None, programs: None, single_operator_quorums_refused: false }
    }

    /// Accepts a host-supplied history for one list (runtime §12 steps 2–4). Returns the newly accepted version.
    pub fn update(&mut self, list: ListKind, history: &[ListVersion]) -> Result<u64, &'static str> {
        let (card, floor, current) = match list {
            ListKind::AcceptedRuntimes => (&self.pins.accepted_runtimes_card, self.pins.accepted_runtimes_floor, &self.runtimes),
            ListKind::ProgramAllowlist => (&self.pins.program_allowlist_card, self.pins.program_allowlist_floor, &self.programs),
        };
        let v = verify_list_approval(list, card, history, &self.pins.keyset)?;
        let (value, version) = (v.value, v.version);
        if version < floor || current.as_ref().is_some_and(|(_, seen)| version < *seen) {
            return Err("LIST_VERSION_REGRESSION");
        }
        let slot = match list {
            ListKind::AcceptedRuntimes => &mut self.runtimes,
            ListKind::ProgramAllowlist => &mut self.programs,
        };
        *slot = Some((value, version));
        if list == ListKind::ProgramAllowlist {
            self.single_operator_quorums_refused = v.single_operator_quorums_refused;
        }
        Ok(version)
    }

    pub fn versions(&self) -> (u64, u64) {
        (self.runtimes.as_ref().map_or(0, |r| r.1), self.programs.as_ref().map_or(0, |p| p.1))
    }

    /// The accepted-runtime list in the form algorithm V needs.
    pub fn accepted_runtimes(&self) -> Vec<AcceptedRuntime> {
        let Some((Value::Array(items), _)) = &self.runtimes else { return vec![] };
        items
            .iter()
            .filter_map(|e| {
                Some(AcceptedRuntime {
                    pcr0: b64u::decode(e.get("pcr0")?.as_str()?).ok()?,
                    platform: e.get("platform")?.as_str()?.to_string(),
                    accepted_from_ms: formats::parse_timestamp(e.get("accepted_from")?.as_str()?).ok()?,
                    retired_at_ms: e.get("retired_at").and_then(Value::as_str).and_then(|s| formats::parse_timestamp(s).ok()),
                    retire_reason: match e.get("retire_reason").and_then(Value::as_str) {
                        Some("vulnerable") => Some(RetireReason::Vulnerable),
                        Some("superseded") => Some(RetireReason::Superseded),
                        _ => None,
                    },
                })
            })
            .collect()
    }

    /// The program allowlist in the form algorithm A (A11) needs.
    pub fn allowlist(&self) -> Option<Vec<notary_admission::AllowlistEntry>> {
        let (Value::Array(items), _) = self.programs.as_ref()? else { return Some(vec![]) };
        Some(
            items
                .iter()
                .filter_map(|e| {
                    Some(notary_admission::AllowlistEntry {
                        program_cid: e.get("program_cid")?.as_str()?.to_string(),
                        accepted_from_ms: formats::parse_timestamp(e.get("accepted_from")?.as_str()?).ok()?,
                        retired_at_ms: e.get("retired_at").and_then(Value::as_str).and_then(|s| formats::parse_timestamp(s).ok()),
                    })
                })
                .collect(),
        )
    }

    /// PCR0s retired as `"vulnerable"` (for the key-lineage check, runtime §4).
    pub fn vulnerable_pcr0s(&self) -> Vec<Vec<u8>> {
        self.accepted_runtimes().into_iter().filter(|r| r.retire_reason == Some(RetireReason::Vulnerable)).map(|r| r.pcr0).collect()
    }
}
