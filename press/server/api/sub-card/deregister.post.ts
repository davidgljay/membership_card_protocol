export default defineEventHandler((event) => {
  setResponseStatus(event, 501);
  return { error: 'NOT_IMPLEMENTED', message: 'POST /sub-card/deregister not yet implemented' };
});
