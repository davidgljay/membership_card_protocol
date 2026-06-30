import http from 'node:http';

const port = Number(process.env.PORT ?? 4000);
let count = 0;

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/deliver/')) {
    count++;
    res.writeHead(200);
    res.end();
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, () => {
  console.log(`fake relay listening on :${port}`);
});

process.on('SIGINT', () => {
  console.log(`total delivered: ${count}`);
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log(`total delivered: ${count}`);
  process.exit(0);
});
