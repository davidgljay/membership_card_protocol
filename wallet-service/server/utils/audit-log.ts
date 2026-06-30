/**
 * Structured JSON audit logging (implementation-plan.md §Step 6.2).
 * Every audit event goes through this single function so the shape is
 * uniform and grep/log-pipeline-friendly: `{ event, level, ...fields,
 * timestamp }`. Never pass key material, raw session tokens, IP
 * addresses, request/response bodies, or subcard_hash-to-device
 * correlations as fields — see the explicit prohibitions in
 * implementation-plan.md §Step 6.2, enforced by test/audit-log-schema.test.ts.
 */

export type AuditLevel = 'info' | 'warn' | 'error';

export function auditLog(level: AuditLevel, event: string, fields: Record<string, string | number | boolean>): void {
  const line = JSON.stringify({ event, level, ...fields, timestamp: new Date().toISOString() });
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.info(line);
  }
}
