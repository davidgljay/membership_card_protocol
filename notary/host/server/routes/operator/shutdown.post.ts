import { run } from '../../utils/respond.js';
import { handleOperatorShutdown } from '../../../src/handlers/replication.js';

/** POST /operator/shutdown — operator token: a local instance stops (`replica_gone` to its peers; 6.3, R5). */
export default defineEventHandler(async (event) => { const body = await readBody(event); return run(event, (ctx) => handleOperatorShutdown(ctx, getHeader(event, 'authorization'), body)); });
