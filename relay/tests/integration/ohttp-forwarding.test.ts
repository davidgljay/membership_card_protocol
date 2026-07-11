/**
 * Integration tests for POST /ohttp/{target_id} oblivious-forwarding.
 *
 * Requires a live Redis instance. Set REDIS_URL (default: redis://localhost:6379).
 * Tests the stateless OHTTP forwarding feature per specs/process_specs/oblivious_transport.md.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { router } from "../../src/router.js";
import { loadAppRegistry } from "../../src/utils/apps.js";
import { loadObliviousTargets } from "../../src/utils/oblivious_targets.js";
import { getRedisClient, closeRedis } from "../../src/utils/storage/redis.js";
import { closeDb } from "../../src/utils/storage/sqlite.js";
import { startStubHttpsServer, type StubHttpsServerHandle } from "./stub-https-server.js";

// Force stub push mode for unrelated features
process.env.NODE_ENV = "development";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

let server: http.Server;
let baseUrl: string;
let tmpDir: string;
let stubGateway: StubHttpsServerHandle;
let origRejectUnauthorized: string | undefined;
let defaultTargetsPath: string;

const TEST_APP_ID = "test-app";

beforeAll(async () => {
  // Disable Node's TLS certificate verification for this test's self-signed stub server.
  // This is only safe for this test where we control both ends of the connection;
  // Node checks NODE_TLS_REJECT_UNAUTHORIZED per-connection, not just at startup,
  // so we can toggle it around the test without affecting other tests in this process.
  origRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  tmpDir = mkdtempSync(join(tmpdir(), "relay-ohttp-int-test-"));
  process.env.DB_PATH = join(tmpDir, "test.db");

  // Set up minimal app registry (required for relay to start, even though OHTTP forwarding doesn't use it)
  const fakeP8 = join(tmpDir, "fake.p8");
  writeFileSync(fakeP8, "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n");

  const appsJson = join(tmpDir, "apps.json");
  writeFileSync(
    appsJson,
    JSON.stringify({
      apps: [
        {
          app_id: TEST_APP_ID,
          platform: "apns",
          wallet_base_url: "https://wallet.example.com",
          apns: {
            key_file: fakeP8,
            key_id: "AAAAAAAAAA",
            team_id: "BBBBBBBBBB",
            bundle_id: "com.test.app",
            sandbox: true,
          },
        },
      ],
    })
  );
  process.env.APP_REGISTRY_PATH = appsJson;
  loadAppRegistry(appsJson);

  // Start the HTTPS stub gateway
  stubGateway = await startStubHttpsServer();

  // Set up oblivious-targets registry
  defaultTargetsPath = join(tmpDir, "oblivious-targets.json");
  writeFileSync(
    defaultTargetsPath,
    JSON.stringify({
      targets: [
        {
          target_id: "wallet-service",
          ohttp_gateway_url: stubGateway.baseUrl,
        },
        {
          target_id: "press-1",
          ohttp_gateway_url: stubGateway.baseUrl,
        },
      ],
    })
  );
  process.env.OBLIVIOUS_TARGETS_PATH = defaultTargetsPath;
  loadObliviousTargets(defaultTargetsPath);

  await getRedisClient().flushdb();

  server = http.createServer((req, res) => {
    Promise.resolve(router(req, res)).catch((err) => {
      console.error(err);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  // Restore Node's TLS certificate verification setting
  if (origRejectUnauthorized === undefined) {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  } else {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = origRejectUnauthorized;
  }

  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
  await stubGateway.close();
  await closeRedis();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await getRedisClient().flushdb();
  stubGateway.requests.splice(0); // Clear array in-place without reassigning
  // Some tests below (the unreachable-gateway and disabled-feature cases)
  // swap in a different registry via loadObliviousTargets(). Since that's a
  // module-level singleton, reset it to the canonical two-target registry
  // before every test rather than relying on test execution order to undo
  // a previous test's mutation.
  loadObliviousTargets(defaultTargetsPath);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function request(
  method: string,
  path: string,
  body?: Buffer | string,
  headers?: Record<string, string>
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const bodyBuffer = body ? (typeof body === "string" ? Buffer.from(body) : body) : Buffer.alloc(0);
    const req = http.request(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(bodyBuffer.length > 0 ? { "Content-Length": String(bodyBuffer.length) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode!,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on("error", reject);
    if (bodyBuffer.length > 0) req.write(bodyBuffer);
    req.end();
  });
}

function post(path: string, body?: Buffer | string, headers?: Record<string, string>) {
  return request("POST", path, body, headers);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("POST /ohttp/{target_id} — oblivious-forwarding", () => {
  it("forwards request body byte-for-byte to the registered gateway and returns response", async () => {
    const testPayload = Buffer.from([0x01, 0x02, 0x03, 0x04, 0xff, 0xfe]);
    const { status, body } = await post(
      "/ohttp/wallet-service",
      testPayload,
      { "content-type": "message/ohttp-req" }
    );

    expect(status).toBe(200);

    // Verify the stub gateway received the exact payload
    expect(stubGateway.requests).toHaveLength(1);
    const stubReq = stubGateway.requests[0];
    expect(stubReq.body).toEqual(testPayload);
    expect(stubReq.headers["content-type"]).toBe("message/ohttp-req");

    // Response body should be the stub's JSON echo (base64-encoded)
    const parsedResponse = JSON.parse(body.toString("utf-8"));
    expect(parsedResponse.echoed).toBe(true);
    expect(parsedResponse.contentType).toBe("message/ohttp-req");
    expect(parsedResponse.bodyBase64).toBe(testPayload.toString("base64"));
  });

  it("forwards a request without a body (empty POST)", async () => {
    const { status } = await post("/ohttp/press-1", Buffer.alloc(0));

    expect(status).toBe(200);
    expect(stubGateway.requests).toHaveLength(1);
    expect(stubGateway.requests[0].body).toEqual(Buffer.alloc(0));
  });

  it("preserves Content-Type header from the request", async () => {
    const testBody = Buffer.from("test-ohttp-payload");
    const { status } = await post(
      "/ohttp/wallet-service",
      testBody,
      { "content-type": "application/octet-stream" }
    );

    expect(status).toBe(200);
    expect(stubGateway.requests[0].headers["content-type"]).toBe("application/octet-stream");
  });

  it("uses default Content-Type if not specified in request", async () => {
    const testBody = Buffer.from("test-ohttp-payload");
    const { status } = await post("/ohttp/wallet-service", testBody);

    expect(status).toBe(200);
    // The relay should have sent application/octet-stream as default if not specified
    expect(stubGateway.requests[0].headers["content-type"]).toBe("application/octet-stream");
  });

  it("returns 404 for an unknown target_id without forwarding", async () => {
    const { status, body } = await post(
      "/ohttp/unknown-target",
      Buffer.from("test"),
      { "content-type": "message/ohttp-req" }
    );

    expect(status).toBe(404);
    const errorBody = JSON.parse(body.toString("utf-8"));
    expect(errorBody.error).toBe("NOT_FOUND");
    expect(errorBody.message).toContain("Unknown target_id");

    // Verify stub gateway did NOT receive anything
    expect(stubGateway.requests).toHaveLength(0);
  });

  it("handles non-UTF-8 binary payloads correctly (byte-for-byte forwarding)", async () => {
    // Create a buffer with non-UTF-8 safe bytes
    const binaryPayload = Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0x00, 0x01, 0x02]);
    const { status } = await post(
      "/ohttp/wallet-service",
      binaryPayload,
      { "content-type": "application/octet-stream" }
    );

    expect(status).toBe(200);
    expect(stubGateway.requests).toHaveLength(1);
    // Verify exact byte preservation
    expect(stubGateway.requests[0].body).toEqual(binaryPayload);
  });

  it("returns 502 when the gateway is unreachable", async () => {
    // Use a target_id with a gateway URL that won't respond
    const targetsJson = join(tmpDir, "oblivious-targets-bad.json");
    writeFileSync(
      targetsJson,
      JSON.stringify({
        targets: [
          {
            target_id: "unreachable",
            ohttp_gateway_url: "https://localhost:9999",
          },
        ],
      })
    );
    loadObliviousTargets(targetsJson);

    const { status, body } = await post("/ohttp/unreachable", Buffer.from("test"));

    expect(status).toBe(502);
    const errorBody = JSON.parse(body.toString("utf-8"));
    expect(errorBody.error).toBe("GATEWAY_UNREACHABLE");
  });

  it("returns 404 when OBLIVIOUS_TARGETS_PATH is not configured", async () => {
    // Temporarily unload the registry by calling with undefined.
    // beforeEach restores the canonical registry before the next test runs.
    loadObliviousTargets(undefined);

    const { status } = await post("/ohttp/wallet-service", Buffer.from("test"));

    expect(status).toBe(404);
  });

  it("preserves response Content-Type header from the gateway", async () => {
    const testPayload = Buffer.from("test-payload");
    const { headers } = await post(
      "/ohttp/wallet-service",
      testPayload,
      { "content-type": "message/ohttp-req" }
    );

    expect(headers["content-type"]).toBe("application/json");
  });

  it("forwards multiple requests to the same target independently", async () => {
    const payload1 = Buffer.from([0x01, 0x02]);
    const payload2 = Buffer.from([0x03, 0x04, 0x05]);

    const res1 = await post("/ohttp/wallet-service", payload1);
    const res2 = await post("/ohttp/wallet-service", payload2);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    expect(stubGateway.requests).toHaveLength(2);
    expect(stubGateway.requests[0].body).toEqual(payload1);
    expect(stubGateway.requests[1].body).toEqual(payload2);
  });
});
