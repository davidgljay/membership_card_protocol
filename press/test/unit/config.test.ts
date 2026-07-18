import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../../src/config.js';

// Build a valid base64url ML-DSA-44 private key stub (2560 zero bytes).
const validMldsaKey = Buffer.alloc(2560).toString('base64url');

const validEnv: Record<string, string> = {
  PRESS_CARD_CID: 'bafybeiabc123',
  PRESS_POLICY_CIDS: 'bafybeipolicy1,bafybeipolicy2',
  PRESS_MLDSA44_PRIVATE_KEY: validMldsaKey,
  PRESS_SECP256R1_PRIVATE_KEY: '0x' + 'ab'.repeat(32),
  PRESS_GAS_WALLET_PRIVATE_KEY: '0x' + 'cd'.repeat(32),
  PRESS_OHTTP_PRIVATE_KEY: Buffer.alloc(32, 7).toString('base64url'),
  ARBITRUM_RPC_URL: 'https://arb1.arbitrum.io/rpc',
  REGISTRY_CONTRACT_ADDRESS: '0x' + '00'.repeat(20),
  FILEBASE_KEY: 'test-key',
  FILEBASE_SECRET: 'test-secret',
  FILEBASE_BUCKET: 'test-bucket',
  EXTERNAL_KV_URL: 'redis://localhost:6379',
};

function setEnv(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) {
    process.env[k] = v;
  }
}

// Vars a test may set beyond validEnv's keys (e.g. to exercise the kubo
// provider path) — cleared alongside validEnv so tests stay isolated.
const EXTRA_CLEARABLE_KEYS = ['IPFS_PROVIDER', 'KUBO_API_URL', 'KUBO_GATEWAY_URL'];

function clearEnv() {
  for (const k of [...Object.keys(validEnv), ...EXTRA_CLEARABLE_KEYS]) {
    delete process.env[k];
  }
}

describe('loadConfig', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearEnv();
    // Prevent actual process exit; capture the call.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number | string | null) => {
      throw new Error('process.exit called');
    });
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errSpy.mockRestore();
    clearEnv();
  });

  it('exits non-zero and names PRESS_CARD_CID when that variable is missing', () => {
    const { PRESS_CARD_CID: _removed, ...env } = validEnv;
    setEnv(env);
    expect(() => loadConfig()).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorMessages = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errorMessages).toContain('PRESS_CARD_CID');
  });

  it('exits non-zero and names PRESS_MLDSA44_PRIVATE_KEY when that variable is missing', () => {
    const { PRESS_MLDSA44_PRIVATE_KEY: _removed, ...env } = validEnv;
    setEnv(env);
    expect(() => loadConfig()).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorMessages = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errorMessages).toContain('PRESS_MLDSA44_PRIVATE_KEY');
  });

  it('exits non-zero when ML-DSA-44 key decodes to wrong byte length', () => {
    const shortKey = Buffer.alloc(64).toString('base64url'); // too short
    setEnv({ ...validEnv, PRESS_MLDSA44_PRIVATE_KEY: shortKey });
    expect(() => loadConfig()).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorMessages = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errorMessages).toContain('PRESS_MLDSA44_PRIVATE_KEY');
    expect(errorMessages).toContain('2560');
  });

  it('exits non-zero when PRESS_SECP256R1_PRIVATE_KEY is not 32-byte hex', () => {
    setEnv({ ...validEnv, PRESS_SECP256R1_PRIVATE_KEY: 'notahexkey' });
    expect(() => loadConfig()).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorMessages = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errorMessages).toContain('PRESS_SECP256R1_PRIVATE_KEY');
  });

  it('exits non-zero when PRESS_POLICY_CIDS is empty after trimming', () => {
    setEnv({ ...validEnv, PRESS_POLICY_CIDS: '  ,  ' });
    expect(() => loadConfig()).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorMessages = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errorMessages).toContain('PRESS_POLICY_CIDS');
  });

  it('succeeds with all valid variables present', () => {
    setEnv(validEnv);
    const config = loadConfig();
    expect(config.PRESS_CARD_CID).toBe('bafybeiabc123');
    expect(config.PRESS_POLICY_CIDS).toEqual(['bafybeipolicy1', 'bafybeipolicy2']);
    expect(config.PRESS_MLDSA44_PRIVATE_KEY).toBeInstanceOf(Uint8Array);
    expect(config.PRESS_MLDSA44_PRIVATE_KEY.length).toBe(2560);
    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.STALENESS_WINDOW_SECONDS).toBe(300);
  });

  it('defaults IPFS_PROVIDER to filebase, preserving existing-deployment behavior', () => {
    const { FILEBASE_BUCKET: _b, ...env } = validEnv;
    setEnv(env);
    const config = loadConfig();
    expect(config.IPFS_PROVIDER).toBe('filebase');
    expect(config.FILEBASE_BUCKET).toBe('membership_card_protocol');
    expect(config.FILEBASE_ENDPOINT).toBe('https://s3.filebase.com');
  });

  it('exits non-zero for an unrecognized IPFS_PROVIDER', () => {
    setEnv({ ...validEnv, IPFS_PROVIDER: 'not-a-provider' });
    expect(() => loadConfig()).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorMessages = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errorMessages).toContain('IPFS_PROVIDER');
  });

  it('does not require FILEBASE_KEY/SECRET when IPFS_PROVIDER is kubo', () => {
    const { FILEBASE_KEY: _k, FILEBASE_SECRET: _s, ...env } = validEnv;
    setEnv({
      ...env,
      IPFS_PROVIDER: 'kubo',
      KUBO_API_URL: 'http://ipfs:5001',
      KUBO_GATEWAY_URL: 'http://ipfs:8080',
    });
    const config = loadConfig();
    expect(config.IPFS_PROVIDER).toBe('kubo');
    expect(config.KUBO_API_URL).toBe('http://ipfs:5001');
  });

  it('exits non-zero when IPFS_PROVIDER is kubo but KUBO_API_URL is missing', () => {
    const { FILEBASE_KEY: _k, FILEBASE_SECRET: _s, ...env } = validEnv;
    setEnv({ ...env, IPFS_PROVIDER: 'kubo', KUBO_GATEWAY_URL: 'http://ipfs:8080' });
    expect(() => loadConfig()).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorMessages = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errorMessages).toContain('KUBO_API_URL');
  });
});
