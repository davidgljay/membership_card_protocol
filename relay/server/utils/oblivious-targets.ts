// Oblivious-forwarding target registry — client-sdk implementation plan
// Step 1.4b. Structurally independent of AppRegistry (server/utils/app-registry.ts):
// target_id is opaque to the relay — it may correspond to a wallet
// service's existing app_id, or to a press's own identifier — the relay
// does not need to know or care which. Loaded the same way as
// AppRegistryFile (bundled JSON asset / *_JSON env var), mirroring that
// module's provisional loading pattern rather than inventing a third one.
//
// Wire format note: the client-sdk's ObliviousProtocolTransport (Step
// 1.4a) sends a JSON body (`{ enc, ciphertext }`, `application/json`) —
// CP-0 resolved on a lightweight custom HPKE envelope, not strict RFC 9458
// Binary HTTP, so this endpoint forwards whatever Content-Type and body
// the client sent byte-for-byte rather than assuming `message/ohttp-req`.

import type { H3Event } from 'h3';
import { getEnv } from './env';

export interface ObliviousTargetConfig {
  target_id: string;
  ohttp_gateway_url: string;
}

export interface ObliviousTargetsFile {
  targets: ObliviousTargetConfig[];
}

export class ObliviousTargetsValidationError extends Error {}

export function validateObliviousTargets(file: ObliviousTargetsFile): void {
  const seenIds = new Set<string>();
  for (const target of file.targets) {
    if (seenIds.has(target.target_id)) {
      throw new ObliviousTargetsValidationError(`Duplicate target_id: ${target.target_id}`);
    }
    seenIds.add(target.target_id);

    if (!/^https:\/\//.test(target.ohttp_gateway_url)) {
      throw new ObliviousTargetsValidationError(
        `ohttp_gateway_url must be https:// for ${target.target_id}`
      );
    }
  }
}

export class ObliviousTargetRegistry {
  private targetsById: Map<string, ObliviousTargetConfig>;

  constructor(file: ObliviousTargetsFile) {
    validateObliviousTargets(file);
    this.targetsById = new Map(file.targets.map((t) => [t.target_id, t]));
  }

  get(targetId: string): ObliviousTargetConfig | undefined {
    return this.targetsById.get(targetId);
  }
}

let cachedRegistry: ObliviousTargetRegistry | null = null;

/**
 * Loads the oblivious-targets registry. Same node-server (filesystem path)
 * vs. cloudflare (inlined JSON env var) split as loadAppRegistry — see
 * that function's doc for the rationale and the flagged provisional-choice
 * caveat, which applies identically here.
 */
export async function loadObliviousTargets(event: H3Event): Promise<ObliviousTargetRegistry> {
  if (cachedRegistry) return cachedRegistry;

  const isNode = typeof process !== 'undefined' && !!process.versions?.node;
  let raw: string;

  if (isNode) {
    const path = getEnv(event, 'OBLIVIOUS_TARGETS_PATH');
    if (!path) {
      throw new Error('OBLIVIOUS_TARGETS_PATH is required under node-server');
    }
    const fs = await import('node:fs/promises');
    raw = await fs.readFile(path, 'utf-8');
  } else {
    const inlined = getEnv(event, 'OBLIVIOUS_TARGETS_JSON');
    if (!inlined) {
      throw new Error(
        'OBLIVIOUS_TARGETS_JSON is required under the cloudflare preset (see server/utils/oblivious-targets.ts module doc)'
      );
    }
    raw = inlined;
  }

  const parsed = JSON.parse(raw) as ObliviousTargetsFile;
  cachedRegistry = new ObliviousTargetRegistry(parsed);
  return cachedRegistry;
}

/** Test-only: reset the module-level cache between test cases. */
export function _resetObliviousTargetsCacheForTests(): void {
  cachedRegistry = null;
}
