/**
 * Revocation semantics per the Chitt Protocol "Revocation Model" section.
 *
 * Code ranges:
 *   7xx — Privilege reduction. Things before effective_date remain valid; new issuances rejected.
 *   8xx — Quiet revocation. Things after effective_date are suspect; things before are trusted.
 *   9xx — Loud revocation. Things after effective_date are invalid; things before are trusted.
 *
 * The `code` field lives on the LogEntry itself (top level), not inside RevocationEntry.
 * Multiple revocation entries: the one with the earliest effective_date governs.
 */

import type { LogEntry, RevocationEntry } from './types.js';

/**
 * A governing revocation combines the entry-level `code` with the
 * `revocation` sub-object's fields.
 */
export interface GoverningRevocation {
  code: number;
  effective_date: string;
  note?: string;
}

/** Returns 7, 8, or 9 for the century of a revocation code (700–999). */
function codeCentury(code: number): 7 | 8 | 9 | null {
  if (code >= 700 && code < 800) return 7;
  if (code >= 800 && code < 900) return 8;
  if (code >= 900 && code < 1000) return 9;
  return null;
}

/**
 * Given the list of log entries for a chitt, find the governing
 * revocation: the 8xx/9xx entry with the earliest effective_date.
 * 7xx entries (privilege reductions) are included since they also
 * carry an effective_date that gates future issuance.
 */
export function findGoverningRevocation(
  entries: LogEntry[],
): GoverningRevocation | null {
  let governing: GoverningRevocation | null = null;

  for (const entry of entries) {
    if (entry.entry_type !== 'revocation' || !entry.revocation) continue;
    const candidate: GoverningRevocation = {
      code: entry.code,
      effective_date: entry.revocation.effective_date,
      note: entry.revocation.note,
    };
    if (governing === null) {
      governing = candidate;
      continue;
    }
    if (Date.parse(candidate.effective_date) < Date.parse(governing.effective_date)) {
      governing = candidate;
    }
  }

  return governing;
}

/**
 * Determine whether a chitt was valid at a given signing time,
 * given the governing revocation (if any).
 *
 * @param revocation     The governing revocation (or null if none).
 * @param signingTimeMs  The signing timestamp in milliseconds since epoch.
 */
export function wasValidAtSigningTime(
  revocation: GoverningRevocation | null,
  signingTimeMs: number,
): boolean {
  if (!revocation) return true;

  const effectiveMs = Date.parse(revocation.effective_date);
  const century = codeCentury(revocation.code);

  switch (century) {
    case 7:
      // Privilege reduction: things before effective_date remain valid
      return signingTimeMs < effectiveMs;
    case 8:
      // Quiet revocation: things before effective_date are trusted
      return signingTimeMs < effectiveMs;
    case 9:
      // Loud revocation: things before effective_date are trusted
      return signingTimeMs < effectiveMs;
    default:
      // Unknown code range: treat as invalid for safety
      return false;
  }
}

/**
 * Determine whether the chitt is currently valid (as of now).
 *
 * @param revocation   The governing revocation (or null if none).
 * @param nowMs        Current time in milliseconds since epoch.
 */
export function isCurrentlyValid(
  revocation: GoverningRevocation | null,
  nowMs: number,
): boolean {
  if (!revocation) return true;

  const effectiveMs = Date.parse(revocation.effective_date);
  const century = codeCentury(revocation.code);

  switch (century) {
    case 7:
      // Privilege reduction: after effective_date, new issuances are rejected
      return nowMs < effectiveMs;
    case 8:
      // Quiet revocation: after effective_date, marked as suspect
      return nowMs < effectiveMs;
    case 9:
      // Loud revocation: after effective_date, invalid
      return nowMs < effectiveMs;
    default:
      return false;
  }
}

/**
 * Summarize revocation status for the structured result.
 */
export function revocationStatus(
  revocation: GoverningRevocation | null,
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
