import { run } from '../utils/respond.js';
import { handlePeer } from '../../src/handlers/admin.js';

/** POST /peer — direct, from peer hosts: relays a peer message to a local instance. */
export default defineEventHandler(async (event) => { const body = await readBody(event); return run(event, (ctx) => handlePeer(ctx, body)); });
