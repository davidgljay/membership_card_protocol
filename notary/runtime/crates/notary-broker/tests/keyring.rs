//! Keyring invariants (runtime §4): I2 (keys only from genesis / admission, never imported), I3 (bindings come from
//! held keys), no job key without an `Admitted` proof, key lineage and exposure, erasure per job.
//!
//! "No job key before admission" is enforced by the type system: `create_job_key` takes `&Admitted`, which only
//! `notary_admission::admit` constructs (its fields are public for reading, but the broker never builds one; the
//! broker tests show a failed admission leaves no key).
use notary_admission::{admit, Admitted, RuntimeContext};
use notary_broker::keyring::{Exposed, Keyring};
use notary_types::formats;
use serde_json::json;

fn admitted() -> Admitted {
    let schema = json!([]);
    let src = format!(
        r#"(module (memory (export "memory") 1 1) (func (export "run") (result i32) (i32.const 0))
            (@custom "notary.abi" "notary_v1") (@custom "notary.output_schema" "{}"))"#,
        String::from_utf8(notary_types::jcs::canonical(&schema).unwrap()).unwrap()
    );
    let b = wat::parse_str(src).unwrap();
    admit(&b, &json!({ "program_cid": formats::cid_of_bytes(&b), "isolation": "dedicated", "output_schema": schema }), &RuntimeContext::default()).unwrap()
}

#[test]
fn identities_and_job_keys_are_created_here_and_bound_from_held_keys() {
    let mut k = Keyring::new(vec![1u8; 48]);
    let card = k.create_identity().card.clone();
    let other = k.create_identity().card.clone();
    assert_ne!(card, other, "each genesis makes a fresh K_id");
    let (idh, chh) = k.identity_binding(&card).unwrap();
    let ident = k.identity(&card).unwrap();
    assert_eq!(idh, notary_crypto::keccak256(ident.id.public_key()));
    assert_eq!(chh, notary_crypto::sha256(&ident.chain.public_key_xy()));
    assert_eq!(card, formats::card_pointer(ident.id.public_key()));
    assert!(k.identity_binding("unknown").is_none(), "I3: no binding for a key not held");

    let a = admitted();
    let j1 = [1u8; 32];
    let pk = k.create_job_key(&a, j1, 0).unwrap().public_key().to_vec();
    assert_eq!(k.job_binding(&j1, 0), Some(notary_crypto::sha256(&pk)));
    assert!(k.create_job_key(&a, j1, 0).is_err(), "a job key is never replaced");
    assert!(k.job_binding(&[2u8; 32], 0).is_none(), "I3: no binding for a job not held");
}

#[test]
fn erasure_is_per_job() {
    let mut k = Keyring::new(vec![1u8; 48]);
    let a = admitted();
    k.create_job_key(&a, [1u8; 32], 0).unwrap();
    k.create_job_key(&a, [2u8; 32], 0).unwrap();
    k.erase_job(&[1u8; 32]);
    assert!(k.job_key(&[1u8; 32], 0).is_none());
    assert!(k.job_key(&[2u8; 32], 0).is_some());
}

#[test]
fn keys_whose_lineage_includes_a_vulnerable_runtime_are_unusable() {
    let mut k = Keyring::new(vec![9u8; 48]);
    let card = k.create_identity().card.clone();
    let a = admitted();
    k.create_job_key(&a, [1u8; 32], 0).unwrap();
    assert!(k.apply_retirements(&[vec![8u8; 48]]).is_empty(), "another runtime's retirement exposes nothing");
    let exposed = k.apply_retirements(&[vec![9u8; 48]]);
    assert_eq!(exposed, vec![Exposed::Identity(card.clone()), Exposed::Job([1u8; 32], 0)]);
    assert!(k.identity(&card).is_none(), "an exposed identity is never used again");
    assert!(k.job_key(&[1u8; 32], 0).is_none(), "an exposed job key is never used again");
    assert!(k.identity_cards().is_empty());
    assert!(k.apply_retirements(&[vec![9u8; 48]]).is_empty(), "reported once");
}

#[test]
fn the_instance_key_is_per_boot() {
    let a = Keyring::new(vec![1u8; 48]);
    let b = Keyring::new(vec![1u8; 48]);
    assert_ne!(a.instance_id(), b.instance_id());
    assert_eq!(a.instance_id(), notary_types::b64u::encode(&notary_crypto::sha256(a.inst().public_key())));
}
