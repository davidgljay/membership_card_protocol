import type {
  RpcProvider,
  LogUpdate,
  VerificationError,
  VerifierConfig,
  ChainLink,
} from "../types.js";

export interface Stage4Result {
  revocation: {
    status: "not_revoked" | "revoked" | "loud_revocation" | "unknown";
    code: number | null;
    effective_date: string | null;
    data_freshness_seconds: number;
  };
  was_valid_at_signing_time: boolean | "skipped";
  is_currently_valid: boolean | "skipped";
  log_updates: LogUpdate[];
  errors: VerificationError[];
}

/**
 * Stage 4 — Revocation Check.
 *
 * There is no on-chain-enumerable per-entry log: the registry contract's
 * `CardEntries` mapping stores only the current `log_head_cid`
 * (`registry_contract.md §3.1`). "The log" for a card is reconstructed here from
 * two independent sources, per `ipfs_card.md §5` / `protocol-objects.md §3`
 * ("Provenance verification"):
 *
 *  1. The card's current head content, already fetched and decrypted by Stage 3
 *     (`ChainLink.card_content`) — either the genesis `CardDocument` (never
 *     updated) or the most recent `LogEntry` (`entry_type`/`code`/`history`/
 *     `card_state`/`revocation`, per `protocol-objects.md §3`).
 *  2. The ground-truth on-chain event replay (`RpcProvider.getCardEventLog`),
 *     which returns only `{cid, timestamp}` pairs — never content.
 *
 * The head content tells us *what* the current state is (revoked or not, which
 * field-update code if any); the on-chain event replay tells us *when* that
 * became true (authoritative block timestamp) and lets us cross-check that the
 * head's self-reported `history` claim matches the real on-chain record.
 */
export async function verifyStage4(
  chain: ChainLink[],
  signingTimestamp: string,
  rpc: RpcProvider,
  config: Pick<VerifierConfig, "revocationFreshnessWindowSeconds" | "rejectStaleRevocation">
): Promise<Stage4Result> {
  const freshnessWindow = config.revocationFreshnessWindowSeconds ?? 300;
  const rejectStale = config.rejectStaleRevocation ?? true;
  const errors: VerificationError[] = [];
  const logUpdates: LogUpdate[] = [];

  const fetchedAt = Date.now();

  // Resolve on-chain CardEntry + event-log replay for every chain member in parallel.
  const perCard = await Promise.all(
    chain.map(async (link) => {
      const [cardEntry, eventLog] = await Promise.all([
        rpc.getCardEntry(link.card_address),
        rpc.getCardEventLog(link.card_address),
      ]);
      return { link, cardEntry, eventLog };
    })
  );

  let earliestRevocation: { code: number; effective_date: string } | null = null;
  let anyContentAvailable = false;
  let anyContentUnavailable = false;

  for (const { link, cardEntry, eventLog } of perCard) {
    const addr = link.card_address;
    const content = link.card_content as Record<string, unknown> | undefined;
    const headCid = cardEntry?.log_head_cid ?? null;

    const hasContent = !!content && Object.keys(content).length > 0;
    if (!hasContent) {
      // No decrypted content available for this chain member (e.g. verifyCard,
      // which has no pubkey and therefore cannot decrypt anything — see §7.3/§7.4
      // "verifyCard limitation" in card_verifier.md). We can still use the event
      // log for provenance bookkeeping, but cannot determine revocation status.
      anyContentUnavailable = true;
      continue;
    }
    anyContentAvailable = true;

    const entryType = content!["entry_type"];
    const isLogEntry = entryType === "field_update" || entryType === "revocation";

    // Provenance cross-check: does the self-reported `history` (+ own CID) match
    // the ground-truth on-chain event replay, in count and order?
    if (isLogEntry && Array.isArray(content!["history"]) && headCid) {
      const claimed = [...(content!["history"] as unknown[]), headCid];
      const actual = eventLog.map((e) => e.cid);
      const matches =
        claimed.length === actual.length && claimed.every((c, i) => c === actual[i]);
      if (!matches) {
        errors.push({
          stage: 4,
          code: "HISTORY_MISMATCH",
          message: `On-chain event log does not match self-reported history for ${addr}`,
        });
      }
    }

    // Authoritative timestamp for the head entry: the on-chain event matching
    // `headCid`, not the IPFS content's self-reported date (a compromised or
    // buggy press could misreport the latter; the on-chain block timestamp cannot
    // be forged after the fact).
    const headEvent = headCid ? eventLog.find((e) => e.cid === headCid) : undefined;

    if (isLogEntry && entryType === "revocation") {
      const code = Number(content!["code"]);
      const reportedDate =
        (content!["revocation"] as { effective_date?: string } | undefined)?.effective_date ??
        null;
      const effectiveDate = headEvent?.timestamp ?? reportedDate;
      if (!headEvent) {
        errors.push({
          stage: 4,
          code: "NO_ONCHAIN_EVENT_FOR_HEAD",
          message: `No on-chain event found matching head CID for ${addr}; falling back to self-reported effective_date`,
        });
      }
      if (effectiveDate) {
        if (!earliestRevocation || effectiveDate < earliestRevocation.effective_date) {
          earliestRevocation = { code, effective_date: effectiveDate };
        }
      }
    } else if (isLogEntry && entryType === "field_update") {
      logUpdates.push({
        card_address: addr,
        update_code: Number(content!["code"]),
        cid: headCid ?? "",
        effective_date: headEvent?.timestamp ?? "",
      });
    }
    // Else: genesis CardDocument, never updated — not revoked, no field updates.
  }

  const dataFreshness = Math.floor((Date.now() - fetchedAt) / 1000);
  const isStale = dataFreshness > freshnessWindow;

  if (isStale) {
    errors.push({
      stage: 4,
      code: "STALE_REVOCATION_DATA",
      message: `Revocation data is ${dataFreshness}s old (limit: ${freshnessWindow}s)`,
    });
  }

  // No decrypted content anywhere in the chain (verifyCard's address-only path):
  // revocation status cannot be determined from content we cannot decrypt.
  if (!anyContentAvailable && anyContentUnavailable) {
    return {
      revocation: {
        status: "unknown",
        code: null,
        effective_date: null,
        data_freshness_seconds: dataFreshness,
      },
      was_valid_at_signing_time: "skipped",
      is_currently_valid: "skipped",
      log_updates: logUpdates,
      errors,
    };
  }

  const now = new Date().toISOString();

  if (!earliestRevocation) {
    const is_currently_valid = isStale && rejectStale ? false : true;
    return {
      revocation: {
        status: "not_revoked",
        code: null,
        effective_date: null,
        data_freshness_seconds: dataFreshness,
      },
      was_valid_at_signing_time: true,
      is_currently_valid,
      log_updates: logUpdates,
      errors,
    };
  }

  const { code, effective_date } = earliestRevocation;
  const is8xx = code >= 800 && code <= 899;
  const status = is8xx ? "revoked" : "loud_revocation";

  const wasValidAtSigning = signingTimestamp < effective_date;
  let isCurrentlyValid = now < effective_date;
  if (isStale && rejectStale) {
    isCurrentlyValid = false;
  }

  return {
    revocation: {
      status,
      code,
      effective_date,
      data_freshness_seconds: dataFreshness,
    },
    was_valid_at_signing_time: wasValidAtSigning,
    is_currently_valid: isCurrentlyValid,
    log_updates: logUpdates,
    errors,
  };
}
