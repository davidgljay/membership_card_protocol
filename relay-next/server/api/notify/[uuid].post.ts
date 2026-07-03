// POST /notify/{uuid} (Deprecated) — relay.md §7.8.

import { setHeader, type H3Event } from 'h3';
import { relayError } from '../../utils/http-errors';

export default defineEventHandler((event: H3Event) => {
  setHeader(event, 'Location', '/deliver/' + (event.context.params?.uuid ?? ''));
  throw relayError('ENDPOINT_DEPRECATED', 'Use POST /deliver/{uuid}');
});
