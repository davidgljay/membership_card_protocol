import { run } from '../../utils/respond.js';
import { handleOperatorSeedTemplate } from '../../../src/handlers/replication.js';

/** POST /operator/template-seed — operator token: the first enclave serving a derived-card template seeds its dup_tag key (6.4). */
export default defineEventHandler(async (event) => { const body = await readBody(event); return run(event, (ctx) => handleOperatorSeedTemplate(ctx, getHeader(event, 'authorization'), body)); });
