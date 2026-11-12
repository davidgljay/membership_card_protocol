//! Attestation `user_data` layout (§33): 181 bytes.
use crate::error::{NotaryError, Result};

pub const LEN: usize = 181;
const TAG: &[u8; 10] = b"CARDNOTARY";

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct UserData {
    pub purpose: u8, // 0x01 genesis | 0x02 job | 0x03 instance | 0x04 admitted
    pub id_key_hash: [u8; 32],
    pub chain_key_hash: [u8; 32],
    pub inst_key_hash: [u8; 32],
    pub program_hash: [u8; 32],
    pub job_hash: [u8; 32],
    pub epoch: u64,
    pub isolation: u8, // 0x00 none | 0x01 shared | 0x02 dedicated
}

impl UserData {
    pub fn encode(&self) -> [u8; LEN] {
        let mut o = [0u8; LEN];
        o[..10].copy_from_slice(TAG);
        o[10] = 0x01;
        o[11] = self.purpose;
        let mut p = 12;
        for f in [&self.id_key_hash, &self.chain_key_hash, &self.inst_key_hash, &self.program_hash, &self.job_hash] {
            o[p..p + 32].copy_from_slice(f);
            p += 32;
        }
        o[p..p + 8].copy_from_slice(&self.epoch.to_be_bytes());
        o[p + 8] = self.isolation;
        o
    }

    pub fn decode(b: &[u8]) -> Result<Self> {
        let bad = |m: &str| NotaryError::new("ATT_USER_DATA_MALFORMED", m.to_string());
        if b.len() != LEN { return Err(bad("length")); }
        if &b[..10] != TAG { return Err(bad("tag")); }
        if b[10] != 0x01 { return Err(bad("layout version")); }
        if !(1..=4).contains(&b[11]) { return Err(bad("purpose")); }
        if b[180] > 2 { return Err(bad("isolation")); }
        let f = |s: usize| -> [u8; 32] { b[s..s + 32].try_into().unwrap() };
        Ok(Self {
            purpose: b[11], id_key_hash: f(12), chain_key_hash: f(44), inst_key_hash: f(76),
            program_hash: f(108), job_hash: f(140),
            epoch: u64::from_be_bytes(b[172..180].try_into().unwrap()), isolation: b[180],
        })
    }
}
