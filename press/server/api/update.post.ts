export default defineEventHandler((event) => {
  setResponseStatus(event, 501);
  return { error: 'NOT_IMPLEMENTED', message: 'POST /update not yet implemented' };
});
