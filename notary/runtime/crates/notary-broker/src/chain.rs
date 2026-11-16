//! Chain data (notary_runtime.md §13): block headers checked by hash linkage only (limit L3), the `chain_ref` freshness
//! floor, and the two clocks close needs (replication §5).
//!
//! Headers arrive as RLP (`chain_headers`). A header's hash is `keccak256(rlp)`; the broker reads `parentHash`
//! (field 0), `stateRoot` (3), `number` (8) and `timestamp` (11). The first header received anchors the chain; every
//! later one must link by parent hash to an accepted header. Older or unlinked headers are ignored.
//!
//! **Retention (6.3, R3 option 1).** The chain keeps a window of recent headers and, beyond it, every header an input
//! the enclave holds names as its `chain_ref` (`pinned`), so close can re-run B3 on early inputs of a long job. A job
//! handoff carries the pinned headers, which the receiver adopts from its attested sender (`adopt_trusted`).
use notary_crypto::keccak256;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Header {
    pub hash: [u8; 32],
    pub parent: [u8; 32],
    pub state_root: [u8; 32],
    pub number: u64,
    pub timestamp: u64,
}

/// Minimal RLP: decodes one list of byte strings (nested lists are skipped as opaque items).
fn rlp_list(b: &[u8]) -> Option<Vec<&[u8]>> {
    fn len_of(b: &[u8], n: usize) -> Option<usize> {
        if n == 0 || n > 8 || b.len() < n {
            return None;
        }
        Some(b[..n].iter().fold(0usize, |a, x| (a << 8) | *x as usize))
    }
    fn item(b: &[u8]) -> Option<(&[u8], usize, bool)> {
        let p = *b.first()?;
        Some(match p {
            0x00..=0x7f => (&b[..1], 1, false),
            0x80..=0xb7 => {
                let l = (p - 0x80) as usize;
                (b.get(1..1 + l)?, 1 + l, false)
            }
            0xb8..=0xbf => {
                let n = (p - 0xb7) as usize;
                let l = len_of(&b[1..], n)?;
                (b.get(1 + n..1 + n + l)?, 1 + n + l, false)
            }
            0xc0..=0xf7 => {
                let l = (p - 0xc0) as usize;
                (b.get(1..1 + l)?, 1 + l, true)
            }
            _ => {
                let n = (p - 0xf7) as usize;
                let l = len_of(&b[1..], n)?;
                (b.get(1 + n..1 + n + l)?, 1 + n + l, true)
            }
        })
    }
    let (body, used, is_list) = item(b)?;
    if !is_list || used != b.len() {
        return None;
    }
    let mut out = vec![];
    let mut rest = body;
    while !rest.is_empty() {
        let (payload, used, _) = item(rest)?;
        out.push(payload);
        rest = &rest[used..];
    }
    Some(out)
}

fn be_u64(b: &[u8]) -> Option<u64> {
    (b.len() <= 8).then(|| b.iter().fold(0u64, |a, x| (a << 8) | *x as u64))
}

pub fn decode_header(rlp: &[u8]) -> Option<Header> {
    let f = rlp_list(rlp)?;
    if f.len() < 12 {
        return None;
    }
    Some(Header {
        hash: keccak256(rlp),
        parent: f[0].try_into().ok()?,
        state_root: f[3].try_into().ok()?,
        number: be_u64(f[8])?,
        timestamp: be_u64(f[11])?,
    })
}

/// Encodes a minimal header (tests and the simulator's chain feed): the 15 London-era fields, unused ones empty.
pub fn encode_test_header(parent: [u8; 32], number: u64, timestamp: u64) -> Vec<u8> {
    fn bytes(b: &[u8]) -> Vec<u8> {
        if b.len() == 1 && b[0] < 0x80 {
            return b.to_vec();
        }
        let mut o = if b.len() <= 55 { vec![0x80 + b.len() as u8] } else { vec![0xb9, (b.len() >> 8) as u8, b.len() as u8] };
        o.extend_from_slice(b);
        o
    }
    fn int(x: u64) -> Vec<u8> {
        let be = x.to_be_bytes();
        let i = be.iter().position(|b| *b != 0).unwrap_or(8);
        bytes(&be[i..])
    }
    let mut items: Vec<Vec<u8>> = vec![bytes(&parent), bytes(&[0u8; 32]), bytes(&[0u8; 20]), bytes(&keccak256(&number.to_be_bytes())), bytes(&[0u8; 32]), bytes(&[0u8; 32]), bytes(&[0u8; 256]), int(1), int(number), int(30_000_000), int(0), int(timestamp), bytes(b""), bytes(&[0u8; 32]), bytes(&[0u8; 8])];
    let body: Vec<u8> = items.drain(..).flatten().collect();
    let mut o = if body.len() <= 55 { vec![0xc0 + body.len() as u8] } else { vec![0xf9, (body.len() >> 8) as u8, body.len() as u8] };
    o.extend(body);
    o
}

#[derive(Debug, Default)]
pub struct HeaderChain {
    by_hash: BTreeMap<[u8; 32], Header>,
    newest: Option<[u8; 32]>,
    /// The newest `chain_ref` accepted from an input (runtime §13 freshness floor).
    floor: u64,
    /// Recent headers kept besides the pinned ones (`KEEP` unless a test lowers it).
    keep: Option<usize>,
}

const KEEP: usize = 100_000;

/// How far the first header's timestamp may be from the attested time (runtime §13).
pub const ANCHOR_MARGIN_MS: i64 = 10 * 60 * 1000;

impl HeaderChain {
    /// Accepts headers that link to the chain (or anchor an empty one). Returns the newest block number.
    /// `pinned` names the headers held inputs point to; they survive pruning (read only when pruning).
    pub fn accept(&mut self, headers: &[Vec<u8>], attested_now_ms: Option<i64>, pinned: &dyn Fn() -> BTreeSet<[u8; 32]>) -> u64 {
        for rlp in headers {
            let Some(h) = decode_header(rlp) else { continue };
            // The first header is the chain's anchor. It is trusted only if its timestamp is near the attested time
            // (runtime §13, limit L4); every later header must link to one already accepted.
            let links = if self.by_hash.is_empty() {
                attested_now_ms.is_some_and(|now| (h.timestamp as i64 * 1000 - now).abs() <= ANCHOR_MARGIN_MS)
            } else {
                self.by_hash.contains_key(&h.parent)
            };
            if !links || self.by_hash.contains_key(&h.hash) {
                continue;
            }
            let newer = self.newest_header().is_none_or(|n| h.number > n.number);
            let hash = h.hash;
            self.by_hash.insert(hash, h);
            if newer {
                self.newest = Some(hash);
            }
        }
        let keep = self.keep.unwrap_or(KEEP);
        if self.by_hash.len() > keep {
            let cutoff = self.newest_header().map_or(0, |n| n.number.saturating_sub(keep as u64 / 2));
            let pins = pinned();
            self.by_hash.retain(|hash, h| h.number >= cutoff || pins.contains(hash));
        }
        self.newest_header().map_or(0, |h| h.number)
    }

    /// A header a job handoff carried: accepted by the sending enclave under these same rules (it passed algorithm P).
    /// It is kept for B3 and never moves this chain's newest header or chain time.
    pub fn adopt_trusted(&mut self, h: Header) {
        self.by_hash.entry(h.hash).or_insert(h);
    }

    pub fn get(&self, hash: &[u8; 32]) -> Option<&Header> {
        self.by_hash.get(hash)
    }

    pub fn set_keep(&mut self, n: usize) {
        self.keep = Some(n);
    }

    pub fn newest_header(&self) -> Option<&Header> {
        self.newest.and_then(|h| self.by_hash.get(&h))
    }

    /// B3: the accepted header with this hash, if its number matches.
    pub fn lookup(&self, hash: &[u8; 32], number: u64) -> Result<&Header, &'static str> {
        match self.by_hash.get(hash) {
            None => Err("INPUT_CHAIN_REF_UNKNOWN"),
            Some(h) if h.number != number => Err("INPUT_CHAIN_REF_MISMATCH"),
            Some(h) => Ok(h),
        }
    }

    pub fn raise_floor(&mut self, number: u64) {
        self.floor = self.floor.max(number);
    }
    pub fn floor(&self) -> u64 {
        self.floor
    }

    /// Chain time in milliseconds (newest accepted header).
    pub fn chain_time_ms(&self) -> Option<i64> {
        self.newest_header().map(|h| h.timestamp as i64 * 1000)
    }
}
