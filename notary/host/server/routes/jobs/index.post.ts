import { run } from '../../utils/respond.js';
import { handleCreateJob } from '../../../src/handlers/jobs.js';

/** POST /jobs — direct, from the job requester: { job, program_cid }. */
export default defineEventHandler(async (event) => { const body = await readBody(event); return run(event, (ctx) => handleCreateJob(ctx, body)); });
