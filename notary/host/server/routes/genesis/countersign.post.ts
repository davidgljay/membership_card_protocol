import { run } from '../../utils/respond.js';
import { handleCountersign } from '../../../src/handlers/admin.js';

/** POST /genesis/countersign — direct, operator-authenticated. */
export default defineEventHandler(async (event) => { const body = await readBody(event); return run(event, (ctx) => handleCountersign(ctx, getHeader(event, 'authorization'), body)); });
