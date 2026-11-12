import { run } from '../utils/respond.js';
import { handleHealth } from '../../src/handlers/admin.js';

/** GET /health — liveness plus the number of attested enclaves. */
export default defineEventHandler((event) => run(event, (ctx) => handleHealth(ctx)));
