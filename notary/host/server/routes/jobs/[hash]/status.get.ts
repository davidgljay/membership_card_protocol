import { run } from '../../../utils/respond.js';
import { handleJobStatus } from '../../../../src/handlers/jobs.js';

/** GET /jobs/{hash}/status — public status only (direct). */
export default defineEventHandler((event) => run(event, (ctx) => handleJobStatus(ctx, getRouterParam(event, 'hash') ?? '')));
