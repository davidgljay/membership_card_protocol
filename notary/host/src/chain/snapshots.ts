/**
 * Policy snapshots and updates (notary_host.md §8; derived_card_revocation_propagation.md §2).
 *
 * The snapshot of a policy holds **every** card registered under it: address, current head CID, last press, and the
 * sub-card registrations of those cards, with the head bytes. It is **never filtered**: the host is never told which
 * cards matter and must not filter, which is what keeps the source card hidden from the operator.
 *
 * Each entry also carries the card's head-event history (`events`: every `CardRegistered` / `CardHeadUpdated` CID with
 * its block timestamp), which Stage 4 needs for the provenance cross-check and authoritative revocation dates, and each
 * sub-card registration carries its `sub_card_doc_cid`, which Stage 2 needs to find the document (step 5.3a, E30).
 */
export interface RegistryEvent {
  kind: "CardRegistered" | "CardHeadUpdated";
  policyAddress: string;
  cardAddress: string;
  headCid: string;
  pressAddress: string;
  block: number;
  /** Block timestamp, ISO 8601. */
  timestamp: string;
}
export interface SubCardEvent { masterCard: string; subCard: string; subCardDocCid: string; active: boolean; block: number }

export interface Snapshot {
  policy_address: string;
  at_block: number;
  entries: { address: string; head_cid: string; last_press: string; events: { cid: string; timestamp: string }[] }[];
  subcards: { master_card: string; sub_card: string; sub_card_doc_cid: string; active: boolean }[];
  heads: { cid: string; bytes: string }[];
}

/** Builds the snapshot for one policy from the registry's events: all cards, in address order. */
export function buildSnapshot(policy: string, events: RegistryEvent[], subcards: SubCardEvent[], heads: Map<string, Uint8Array>, atBlock: number): Snapshot {
  const cur = new Map<string, { head: string; press: string; block: number; events: { cid: string; timestamp: string }[] }>();
  for (const e of [...events].filter((x) => x.policyAddress === policy && x.block <= atBlock).sort((a, b) => a.block - b.block)) {
    const prev = cur.get(e.cardAddress)?.events ?? [];
    cur.set(e.cardAddress, { head: e.headCid, press: e.pressAddress, block: e.block, events: [...prev, { cid: e.headCid, timestamp: e.timestamp }] });
  }
  const addrs = [...cur.keys()].sort();
  const subs = new Map<string, SubCardEvent>();
  for (const s of [...subcards].filter((x) => x.block <= atBlock).sort((a, b) => a.block - b.block)) subs.set(`${s.masterCard}:${s.subCard}`, s);
  return {
    policy_address: policy, at_block: atBlock,
    entries: addrs.map((a) => ({ address: a, head_cid: cur.get(a)!.head, last_press: cur.get(a)!.press, events: cur.get(a)!.events })),
    subcards: [...subs.values()].filter((s) => cur.has(s.masterCard)).map((s) => ({ master_card: s.masterCard, sub_card: s.subCard, sub_card_doc_cid: s.subCardDocCid, active: s.active })),
    heads: addrs.map((a) => ({ cid: cur.get(a)!.head, bytes: Buffer.from(heads.get(cur.get(a)!.head) ?? new Uint8Array()).toString("base64url") })),
  };
}

/** The updates since `sinceBlock` for the policy: every `CardRegistered` / `CardHeadUpdated`, unfiltered. */
export function buildUpdates(policy: string, events: RegistryEvent[], sinceBlock: number, heads: Map<string, Uint8Array>) {
  return events.filter((e) => e.policyAddress === policy && e.block > sinceBlock).sort((a, b) => a.block - b.block)
    .map((e) => ({ kind: e.kind, card_address: e.cardAddress, head_cid: e.headCid, press: e.pressAddress, block: e.block, timestamp: e.timestamp, bytes: Buffer.from(heads.get(e.headCid) ?? new Uint8Array()).toString("base64url") }));
}
