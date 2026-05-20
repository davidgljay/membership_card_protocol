/**
 * Revocation semantics per the Chitt Protocol "Revocation Model" section.
 *
 * Code ranges:
 *   7xx — Friendly revocation. Things before effective_date remain valid; new issuances rejected.
 *   8xx — Key compromise. Things after effective_date are suspect; things before are trusted.
 *   9xx — Malicious/bad-faith. Things after effective_date are invalid; things before are trusted.
 *
 * Multiple revocation entries: the one with the earliest effective_date governs.
 */

import type { LogEntry, RevocationEntry } from './types.js';

/** Returns 7, 8, or 9 for the century of a revocation code (700-999). */
function codeCentury(code: number): 7 | 8 | 9 | null {
  if (code >= 700 && code < 800) return 7;
  if (code >= 800 && code < 900) return 8;
  if (code >= 900 && code < 1000) return 9;
  return null;
}

/**
 * Given the list of revocation log entries for a chitt, find the governing
 * revocation: the one with the earliest effective_date.
 */
export function findGoverningRevocation(
  entries: LogEntry[],
): RevocationEntry | null {
  let governing: RevocationEntry | null = null;

  for (const entry of entries) {
    if (entry.entry_type !== 'revocation' || !entry.revocation) continue;
    const rev = entry.revocation;
    if (governing === null) {
      governing = rev;
      continue;
    }
    const effectiveDate = Date.parse(rev.effective_date);
    const currentBest = Date.parse(governing.effective_date);
    if (effectiveDate < currentBest) {
      governing = rev;
    }
  }

  return governing;
}

/**
 * Determine whether a chitt was valid at a given signing time,
 * given the governing revocation (if any).
 *
 * @param revocation     The governing revocation entry (or null if none).
 * @param signingTimeMs  The signing timestamp in milliseconds since epoch.
 */
export function wasValidAtSigningTime(
  revocation: RevocationEntry | null,
  signingTimeMs: number,
): boolean {
  if (!revocation) return true;

  const effectiveMs = Date.parse(revocation.effective_date);
  const century = codeCentury(revocation.code);

  switch (century) {
    case 7:
      // Friendly: things before effective_date remain valid
      return signingTimeMs < effectiveMs;
    case 8:
      // Key compromise: things before effective_date are trusted
      return signingTimeMs < effectiveMs;
    case 9:
      // Malicious: things before effective_date are trusted
      return signingTimeMs < effectiveMs;
    default:
      // Unknown code range: treat as invalid for safety
      return false;
  }
}

/**
 * Determine whether the chitt is currently valid (as of now).
 *
 * @param revocation   The governing revocation entry (or null if none).
 * @param nowMs        Current time in milliseconds since epoch.
 */
export function isCurrentlyValid(
  revocation: RevocationEntry | null,
  nowMs: number,
): boolean {
  if (!revocation) return true;

  const effectiveMs = Date.parse(revocation.effective_date);
  const century = codeCentury(revocation.code);

  switch (century) {
    case 7:
      // Friendly: after effective_date, new issuances are rejected; existing ok
      return nowMs < effectiveMs;
    case 8:
      // Key compromise: after effective_date, marked as suspect → not currently valid
      return nowMs < effectiveMs;
    case 9:
      // Malicious: after effective_date, invalid
      return nowMs < effectiveMs;
    default:
      return false;
  }
}

/**
 * Summarize revocation status for the structured result.
 */
export function revocationStatus(
  revocation: RevocationEntry | null,
  fetchedAt: Date,
): {
  status: 'none' | 'revoked';
  code: number | null;
  effective_date: string | null;
  data_freshness_seconds: number;
} {
  const freshness = Math.floor((Date.now() - fetchedAt.getTime()) / 1000);
  if (!revocation) {
    return { status: 'none', code: null, effective_date: null, data_freshness_seconds: freshness };
  }
  return {
    status: 'revoked',
    code: revocation.code,
    effective_date: revocation.effective_date,
    data_freshness_seconds: freshness,
  };
}
