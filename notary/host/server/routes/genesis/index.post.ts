import { run } from '../../utils/respond.js';
import { handleGenesis } from '../../../src/handlers/admin.js';

/** POST /genesis — direct, operator-authenticated: starts notary genesis. */
export default defineEventHandler(async (event) => { const body = await readBody(event); return run(event, (ctx) => handleGenesis(ctx, getHeader(event, 'authorization'), body)); });
