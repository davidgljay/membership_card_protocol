// A minimal self-signed-HTTPS stub server standing in for an
// oblivious-target's ohttp_gateway_url (client-sdk implementation plan
// Step 1.4b's integration test needs a real reachable HTTPS endpoint,
// since server/utils/oblivious-targets.ts's validation requires
// ohttp_gateway_url to be https://). Cert generation mirrors
// server/utils/redis/test-resp-server.ts's createDevCertificate — shells
// out to openssl rather than adding a cert-generation dependency, same
// rationale as that module.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface StubHttpsServerHandle {
  baseUrl: string;
  certPem: string;
  requests: Array<{ headers: Record<string, string | string[] | undefined>; body: Buffer }>;
  close(): Promise<void>;
}

function createDevCertificate(): { key: string; cert: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'relay-stub-https-cert-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');

  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-nodes',
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
  ]);

  return { key: readFileSync(keyPath, 'utf-8'), cert: readFileSync(certPath, 'utf-8') };
}

/**
 * Starts an HTTPS server that echoes back whatever it receives, wrapped in
 * `{ echoed: true, contentType, bodyBase64 }` JSON — enough for a test to
 * assert the relay forwarded the exact bytes/headers it received, and that
 * the relay's own response back to the caller carries the gateway's
 * response through unmodified.
 */
export async function startStubHttpsServer(): Promise<StubHttpsServerHandle> {
  const { key, cert } = createDevCertificate();
  const requests: StubHttpsServerHandle['requests'] = [];

  const server: Server = createServer({ key, cert }, (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({ headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      res.writeHead(200);
      res.end(
        JSON.stringify({
          echoed: true,
          contentType: req.headers['content-type'] ?? null,
          bodyBase64: body.toString('base64'),
        })
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('stub https server failed to bind to a port');
  }

  return {
    baseUrl: `https://127.0.0.1:${address.port}`,
    certPem: cert,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
