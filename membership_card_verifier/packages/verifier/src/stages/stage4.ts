import type {
  RpcProvider,
  LogUpdate,
  VerificationError,
  VerifierConfig,
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

export async function verifyStage4(
  chainCardAddresses: string[],
  signingTimestamp: string,
  rpc: RpcProvider,
  config: Pick<VerifierConfig, "revocationFreshnessWindowSeconds" | "rejectStaleRevocation">
): Promise<Stage4Result> {
  const freshnessWindow = config.revocationFreshnessWindowSeconds ?? 300;
  const rejectStale = config.rejectStaleRevocation ?? true;
  const errors: VerificationError[] = [];
  const logUpdates: LogUpdate[] = [];

  const fetchedAt = Date.now();

  // Parallel log fetches for all cards in the chain
  const allLogs = await Promise.all(
    chainCardAddresses.map(async (addr) => {
      const entries = await rpc.getLogEntries(addr);
      return { addr, entries };
    })
  );

  // Collect non-revocation updates (1xx–7xx) and find earliest revocation
  let earliestRevocation: { code: number; effective_date: string } | null = null;

  for (const { addr, entries } of allLogs) {
    for (const entry of entries) {
      const code = entry.update_code;
      if (code >= 100 && code <= 799) {
        logUpdates.push({
          card_address: addr,
          update_code: code,
          cid: entry.cid,
          effective_date: entry.effective_date,
        });
      } else if (code >= 800) {
        // 8xx or 9xx revocation
        if (
          !earliestRevocation ||
          entry.effective_date < earliestRevocation.effective_date
        ) {
          earliestRevocation = { code, effective_date: entry.effective_date };
        }
      }
    }
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
