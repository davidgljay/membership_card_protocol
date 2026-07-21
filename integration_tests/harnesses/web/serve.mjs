/**
 * Static file server + same-origin reverse proxy for the Playwright harness.
 *
 * The browser page is served from this single origin (http://localhost:PORT).
 * press/wallet-service/relay have no CORS headers (a real gap worth fixing in
 * those services eventually, but out of scope for this harness) — routing
 * every browser-side call through `/proxy/<service>/...` on this same origin
 * sidesteps CORS entirely rather than requiring product-code changes just to
 * make a test harness's cross-origin fetches work.
 *
 * Node-side calls (prepare.ts, run before the page loads) talk to the real
 * ports directly — Node isn't CORS-restricted, so only browser-facing URLs
 * need to route through this proxy (see smoke.spec.ts's `toBrowserConfig`).
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';

const PORT = Number(process.env.PORT ?? 8901);
const STATIC_DIR = join(import.meta.dirname, 'static');

const PROXY_TARGETS = {
  press: process.env.HARNESS_PRESS_URL ?? 'http://localhost:3001',
  'wallet-service': process.env.HARNESS_WALLET_SERVICE_URL ?? 'http://localhost:3002',
  relay: process.env.HARNESS_RELAY_URL ?? 'http://localhost:3000',
  // nitro-devnode's RPC has no CORS headers either (unlike public Sepolia
  // RPCs, which set permissive CORS for dapp/browser compatibility) — same
  // gap, same fix.
  rpc: process.env.HARNESS_ARBITRUM_RPC_URL ?? 'http://localhost:8547',
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
};

async function handleProxy(req, res, service, rest) {
  const target = PROXY_TARGETS[service];
  if (!target) {
    res.writeHead(404).end(`unknown proxy target: ${service}`);
    return;
  }
  const url = `${target}${rest}`;
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readRequestBody(req);
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;

  const upstream = await fetch(url, { method: req.method, headers, body });
  const responseHeaders = Object.fromEntries(upstream.headers.entries());
  delete responseHeaders['content-encoding'];
  delete responseHeaders['transfer-encoding'];
  // fetch() transparently decompresses a gzip/deflate/br upstream body, so
  // the original content-length (measured on the compressed bytes) is
  // stale once decompressed — forwarding it truncates the response at the
  // client. Node sets a fresh one from the actual buffer length below.
  delete responseHeaders['content-length'];
  res.writeHead(upstream.status, responseHeaders);
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleStatic(req, res, pathname) {
  const relative = pathname === '/' ? '/index.html' : pathname;
  const filePath = normalize(join(STATIC_DIR, relative));
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const contents = await readFile(filePath);
    const ext = filePath.slice(filePath.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(contents);
  } catch {
    res.writeHead(404).end('not found');
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const proxyMatch = url.pathname.match(/^\/proxy\/([^/]+)(\/.*)?$/);
  if (proxyMatch) {
    const [, service, rest] = proxyMatch;
    handleProxy(req, res, service, rest ?? '/').catch((err) => {
      res.writeHead(502).end(`proxy error: ${err instanceof Error ? err.message : String(err)}`);
    });
    return;
  }
  handleStatic(req, res, url.pathname).catch((err) => {
    res.writeHead(500).end(`static error: ${err instanceof Error ? err.message : String(err)}`);
  });
});

server.listen(PORT, () => {
  console.log(`harness server listening on http://localhost:${PORT}`);
});
