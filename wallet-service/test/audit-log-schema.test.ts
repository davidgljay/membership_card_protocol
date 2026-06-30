import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Static log-schema audit (implementation-plan.md §Step 6.2 "Done when:
 * automated log-schema test asserts that no device IO endpoint emits IP,
 * request body, or device-correlating fields").
 *
 * "Device IO" endpoints per the plan: inbound messages, UUID registration,
 * sub-card registration. This walks every route file under those paths
 * and statically checks for the explicit prohibitions — not a substitute
 * for code review, but enough to catch an accidental regression (e.g.
 * someone adding `console.log(getRequestIP(event))` to a device IO route).
 */

const DEVICE_IO_ROOTS = ['server/routes/messages', 'server/routes/cards'];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Extracts the argument text of every console.{info,warn,error,log}(...) call in a source string. */
function extractConsoleCallArgs(source: string): string[] {
  const calls: string[] = [];
  const callStart = /console\.(info|warn|error|log)\(/g;
  let match: RegExpExecArray | null;
  while ((match = callStart.exec(source))) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') depth--;
      i++;
    }
    calls.push(source.slice(start, i - 1));
  }
  return calls;
}

const deviceIoFiles = DEVICE_IO_ROOTS.flatMap((root) => listTsFiles(root));

describe('audit log schema — device IO endpoints', () => {
  it('found at least one device IO route file to check (sanity check that the test isn\'t accidentally vacuous)', () => {
    expect(deviceIoFiles.length).toBeGreaterThan(0);
  });

  it.each(deviceIoFiles)('%s does not call getRequestIP or read x-forwarded-for', (file) => {
    const source = readFileSync(file, 'utf8');
    expect(source).not.toMatch(/getRequestIP/);
    expect(source).not.toMatch(/x-forwarded-for/i);
  });

  it.each(deviceIoFiles)('%s logs never interpolate the subcardHash variable (subcard_hash value)', (file) => {
    const source = readFileSync(file, 'utf8');
    for (const call of extractConsoleCallArgs(source)) {
      expect(call).not.toMatch(/subcardHash/);
    }
  });

  it.each(deviceIoFiles)('%s logs never reference a raw session token or Authorization header value', (file) => {
    const source = readFileSync(file, 'utf8');
    for (const call of extractConsoleCallArgs(source)) {
      expect(call).not.toMatch(/session\.token\b/);
      expect(call.toLowerCase()).not.toMatch(/authorization/);
    }
  });

  it.each(deviceIoFiles)('%s logs never dump the raw request body', (file) => {
    const source = readFileSync(file, 'utf8');
    for (const call of extractConsoleCallArgs(source)) {
      // readBody()'s result is conventionally destructured/named `body` in
      // this codebase — flag any log call that references it wholesale.
      expect(call).not.toMatch(/\bbody\b/);
    }
  });
});

describe('audit log schema — required structured events exist', () => {
  const requiredEvents = [
    ['server/routes/accounts/index.post.ts', 'service_secret_created'],
    ['server/routes/accounts/index.post.ts', 'account_created'],
    ['server/routes/accounts/[card_hash]/service-secret.get.ts', 'service_secret_accessed'],
    ['server/routes/accounts/[card_hash]/backups/index.post.ts', 'backup_registration_created'],
    ['server/routes/accounts/[card_hash]/recovery.post.ts', 'recovery_initiated'],
    ['server/routes/recovery/[recovery_id]/cancel.post.ts', 'recovery_cancelled'],
    ['server/routes/recovery/[recovery_id]/release.get.ts', 'recovery_key_released'],
    ['server/routes/bindings/announce.post.ts', 'binding_announcement_processed'],
  ] as const;

  it.each(requiredEvents)('%s emits the %s audit event', (file, eventName) => {
    const source = readFileSync(file, 'utf8');
    expect(source).toContain(`'${eventName}'`);
  });
});
