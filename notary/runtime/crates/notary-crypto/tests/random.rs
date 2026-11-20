//! Randomness and the shuffle (Q12, step 6.4): one `random_bytes` backed by `getrandom`; Fisher–Yates where every
//! index comes from rejection sampling.
use notary_crypto::{hmac_sha256, random_bytes, sha256, shuffle, shuffle_with, uniform_below};
use std::collections::BTreeMap;

/// A deterministic byte stream: SHA-256 in counter mode over a seed.
struct Stream {
    seed: &'static [u8],
    ctr: u64,
    buf: Vec<u8>,
}
impl Stream {
    fn new(seed: &'static [u8]) -> Self {
        Self { seed, ctr: 0, buf: vec![] }
    }
    fn fill(&mut self, dst: &mut [u8]) {
        while self.buf.len() < dst.len() {
            let mut m = self.seed.to_vec();
            m.extend_from_slice(&self.ctr.to_be_bytes());
            self.ctr += 1;
            self.buf.extend_from_slice(&sha256(&m));
        }
        let rest = self.buf.split_off(dst.len());
        dst.copy_from_slice(&self.buf);
        self.buf = rest;
    }
}

#[test]
fn hmac_sha256_matches_rfc_4231() {
    let h = |k: &[u8], m: &[u8]| hmac_sha256(k, m).iter().map(|b| format!("{b:02x}")).collect::<String>();
    assert_eq!(h(&[0x0b; 20], b"Hi There"), "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
    assert_eq!(h(b"Jefe", b"what do ya want for nothing?"), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    // a key longer than the block is hashed first (RFC 4231 case 6)
    assert_eq!(h(&[0xaa; 131], b"Test Using Larger Than Block-Size Key - Hash Key First"), "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
}

#[test]
fn random_bytes_have_the_length_asked_and_differ() {
    assert_eq!(random_bytes(0).len(), 0);
    let (a, b) = (random_bytes(32), random_bytes(32));
    assert_eq!((a.len(), b.len()), (32, 32));
    assert_ne!(a, b);
}

/// The algorithm, fixed: the same stream gives the same permutation, and this is what it is. A change to the algorithm
/// (the draw order, the rejection rule, the swap) changes this output.
#[test]
fn a_fixed_seed_shuffle_is_deterministic_and_pinned() {
    let run = |seed: &'static [u8]| {
        let mut v: Vec<u32> = (0..10).collect();
        let mut s = Stream::new(seed);
        shuffle_with(&mut v, &mut |d| s.fill(d));
        v
    };
    assert_eq!(run(b"seed-1"), run(b"seed-1"));
    assert_ne!(run(b"seed-1"), run(b"seed-2"));
    assert_eq!(run(b"seed-1"), vec![5, 7, 0, 2, 8, 4, 9, 1, 3, 6], "pinned output of the algorithm for this stream");
}

#[test]
fn rejection_sampling_discards_the_biased_zone() {
    // n = 3: 2^64 mod 3 = 1, so the draw 0 is discarded and the next one is used; the draw 1 gives residue 1.
    let mut draws = vec![0u64, 1].into_iter();
    let mut calls = 0;
    let v = uniform_below(3, &mut |d: &mut [u8]| {
        calls += 1;
        d.copy_from_slice(&draws.next().unwrap().to_le_bytes());
    });
    assert_eq!((v, calls), (1, 2), "the first draw is below 2^64 mod 3 and is rejected");
    // a power of two never rejects
    let mut calls = 0;
    assert_eq!(uniform_below(8, &mut |d: &mut [u8]| { calls += 1; d.copy_from_slice(&13u64.to_le_bytes()) }), 5);
    assert_eq!(calls, 1);
    // n = 1 is always 0
    assert_eq!(uniform_below(1, &mut |d: &mut [u8]| d.copy_from_slice(&u64::MAX.to_le_bytes())), 0);
    // exhaustive over the rejection rule on a small stand-in: with a 64-bit word the accepted draws per residue are equal
    for n in [3u64, 5, 6, 7, 10, 1000, u64::MAX / 3 + 1] {
        let t = n.wrapping_neg() % n;
        assert_eq!((u64::MAX - t + 1) % n, 0, "the accepted range is a whole multiple of n for n = {n}");
    }
}

#[test]
fn every_permutation_of_a_small_set_occurs_about_equally_often() {
    let mut counts: BTreeMap<Vec<u8>, u32> = BTreeMap::new();
    let trials = 24_000u32;
    for _ in 0..trials {
        let mut v = vec![0u8, 1, 2, 3];
        shuffle(&mut v);
        *counts.entry(v).or_default() += 1;
    }
    assert_eq!(counts.len(), 24, "all 4! orders occur");
    // each expected 1,000 times (sd about 31): six sigma either side
    for (p, c) in &counts {
        assert!((800..=1200).contains(c), "{p:?} occurred {c} times of {trials}");
    }
}

#[test]
fn a_shuffle_keeps_the_elements() {
    let mut v: Vec<u32> = (0..100).collect();
    shuffle(&mut v);
    let mut s = v.clone();
    s.sort();
    assert_eq!(s, (0..100).collect::<Vec<_>>());
    let mut empty: Vec<u8> = vec![];
    shuffle(&mut empty);
    let mut one = vec![7];
    shuffle(&mut one);
    assert_eq!(one, vec![7]);
}
