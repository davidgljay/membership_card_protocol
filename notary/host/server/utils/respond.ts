import { HostError } from '../../src/context.js';
import { getCtx, isHostReady } from '../plugins/startup.js';
import type { HostContext } from '../../src/context.js';
type H3Event = Parameters<Parameters<typeof defineEventHandler>[0]>[0];

/** Runs a handler against the host context and maps `HostError` to `{ error, message }` with its status (notary_host.md §14). */
export async function run<T>(event: H3Event, fn: (ctx: HostContext) => Promise<T> | T): Promise<T | { error: string; message: string }> {
  if (!isHostReady()) { setResponseStatus(event, 503); return { error: 'NH_ENCLAVE_UNAVAILABLE', message: 'Host is initializing' }; }
  try { return await fn(getCtx()); } catch (e) {
    if (e instanceof HostError) { setResponseStatus(event, e.status); return { error: e.code, message: e.message }; }
    throw e;
  }
}
