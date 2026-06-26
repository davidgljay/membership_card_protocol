export default defineEventHandler((event) => {
  setResponseStatus(event, 501);
  return { error: 'NOT_IMPLEMENTED', message: 'POST /issue/finalize not yet implemented' };
});
