export default defineEventHandler((event) => {
  setResponseStatus(event, 501);
  return { error: 'NOT_IMPLEMENTED', message: 'POST /open-offer/claim not yet implemented' };
});
