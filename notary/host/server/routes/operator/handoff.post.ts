import { run } from '../../utils/respond.js';
import { handleOperatorHandoff } from '../../../src/handlers/replication.js';

/** POST /operator/handoff — operator token: an identity or template handoff between instances (6.3, R5). */
export default defineEventHandler(async (event) => { const body = await readBody(event); return run(event, (ctx) => handleOperatorHandoff(ctx, getHeader(event, 'authorization'), body)); });
