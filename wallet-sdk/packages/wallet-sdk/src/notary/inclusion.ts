/**
 * Inclusion check (wallet_sdk.md §7b.6; protocol-objects.md §27): is the wallet's latest accepted
 * `input_hash` among the notarization's `counted_inputs`, and does the Merkle root match `input_commitment`?
 * Also builds Merkle inclusion paths so a contributor can prove inclusion against the commitment alone.
 */
import { b64uDecode, compareBytes, inputCommitment } from "@membership-card-protocol/verifier/notary";
import { sha256 } from "@noble/hashes/sha256";

export type InclusionResult =
  | { included: true }
  | { included: false; reason: "COMMITMENT_MISMATCH" | "NOT_COUNTED" | "LIST_INVALID" };

/** `countedInputs`: the sorted list from the `counted_inputs` object (base64url input hashes). */
export function checkInclusion(inputHashB64: string, countedInputs: string[], inputCommitmentB64: string): InclusionResult {
  let list: Uint8Array[];
  try { list = countedInputs.map((h) => b64uDecode(h, 32)); } catch { return { included: false, reason: "LIST_INVALID" }; }
  let root: Uint8Array;
  try { root = inputCommitment(list); } catch { return { included: false, reason: "LIST_INVALID" }; }
  if (compareBytes(root, b64uDecode(inputCommitmentB64, 32)) !== 0) return { included: false, reason: "COMMITMENT_MISMATCH" };
  const mine = b64uDecode(inputHashB64, 32);
  return list.some((h) => compareBytes(h, mine) === 0) ? { included: true } : { included: false, reason: "NOT_COUNTED" };
}

export interface MerkleStep { side: "left" | "right"; hash: Uint8Array }

/** Merkle path for `index` in the sorted list (odd nodes are promoted unchanged, so some levels have no sibling). */
export function inclusionPath(sorted: Uint8Array[], index: number): MerkleStep[] {
  const cat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]));
  let level = sorted.map((h) => sha256(cat(Uint8Array.of(0), h)));
  let i = index;
  const path: MerkleStep[] = [];
  while (level.length > 1) {
    const sib = i ^ 1;
    if (sib < level.length) path.push({ side: sib < i ? "left" : "right", hash: level[sib]! });
    const next: Uint8Array[] = [];
    for (let k = 0; k < level.length; k += 2) next.push(k + 1 < level.length ? sha256(cat(Uint8Array.of(1), level[k]!, level[k + 1]!)) : level[k]!);
    level = next;
    i >>= 1;
  }
  return path;
}

export function verifyInclusionPath(inputHash: Uint8Array, path: MerkleStep[], root: Uint8Array): boolean {
  const cat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]));
  let h = sha256(cat(Uint8Array.of(0), inputHash));
  for (const s of path) h = s.side === "left" ? sha256(cat(Uint8Array.of(1), s.hash, h)) : sha256(cat(Uint8Array.of(1), h, s.hash));
  return compareBytes(h, root) === 0;
}
