/**
 * HostReceipt (protocol-objects.md §25): proof that the operator received the ciphertext, signed with K_host
 * (ML-DSA-44, `operator_host_pubkey` on the notary card). If the input later goes missing, the loss is
 * attributable to this operator.
 */
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { b64uEncode, canonicalNotary } from "@membership-card-protocol/wallet-sdk/notary-types";
import type { HostReceipt } from "@membership-card-protocol/wallet-sdk/notary-types";

export function hostKeys(seed: Uint8Array) {
  const { publicKey, secretKey } = ml_dsa44.keygen(seed);
  return { publicKey, secretKey };
}

export function signHostReceipt(keys: { publicKey: Uint8Array; secretKey: Uint8Array }, r: Omit<HostReceipt, "host_signature">): HostReceipt {
  const sig = ml_dsa44.sign(canonicalNotary(r), keys.secretKey);
  return { ...r, host_signature: { public_key: b64uEncode(keys.publicKey), signature: b64uEncode(sig) } };
}
