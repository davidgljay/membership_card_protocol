export default defineEventHandler((event) => {
  setResponseStatus(event, 501);
  return { error: 'NOT_IMPLEMENTED', message: 'GET /app-gas/:address not yet implemented' };
});
