import { run } from '../../../utils/respond.js';
import { handleRestartJob } from '../../../../src/handlers/jobs.js';

/** POST /jobs/{hash}/restart — direct, operator-authenticated. Moves a job whose replicas were all lost to a new epoch. */
export default defineEventHandler(async (event) => {
  const hash = getRouterParam(event, 'hash') ?? '';
  const body = await readBody(event);
  return run(event, (ctx) => handleRestartJob(ctx, getHeader(event, 'authorization'), hash, body));
});
