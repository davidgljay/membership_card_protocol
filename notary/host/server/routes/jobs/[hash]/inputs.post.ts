/**
 * Reachable **only** through the oblivious gateway (notary_host.md §5): a direct request is refused. The gateway
 * dispatches in-process (src/ohttp-router.ts), never over HTTP to this file.
 */
export default defineEventHandler((event) => {
  setResponseStatus(event, 403);
  return { error: 'NH_DIRECT_FORBIDDEN', message: 'This route is reachable only through the oblivious gateway.' };
});
