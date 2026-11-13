/**
 * Single-operator quorums (notary_lifecycle.md L4; protocol-objects.md §34 `single_operator_quorums`).
 *
 * A job has a single-operator quorum when the replicas whose notary cards share one `operator_card` number at least
 * q = ⌊N/2⌋ + 1: that operator alone can close the job, and alone controls the registry state its replicas check cards
 * against. A replica whose operator is unknown is grouped by itself, so the answer is decided by the cards whose
 * operators are known; callers that must fail closed check `unknown` too.
 */
export function singleOperatorQuorum(
  replicaSet: { notary_card: string; instances: number }[],
  operatorOf: (notaryCard: string) => string | undefined,
): { single: boolean; unknown: boolean } {
  const n = replicaSet.reduce((a, r) => a + r.instances, 0);
  const q = Math.floor(n / 2) + 1;
  const byOperator = new Map<string, number>();
  let unknown = false;
  for (const r of replicaSet) {
    const op = operatorOf(r.notary_card);
    if (op === undefined || op === "") unknown = true;
    const key = op ? `op:${op}` : `card:${r.notary_card}`;
    byOperator.set(key, (byOperator.get(key) ?? 0) + r.instances);
  }
  return { single: [...byOperator.values()].some((c) => c >= q), unknown };
}

/** The consent text for a single-operator quorum (notary_lifecycle.md step 25). */
export const SINGLE_OPERATOR_DISCLOSURE =
  "One operator runs enough of this job's notaries to close it alone. The count can include contributors that operator invents. Your own input stays private either way.";
