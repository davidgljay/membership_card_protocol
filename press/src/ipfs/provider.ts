/**
 * IpfsPinningProvider — the press's abstraction over "upload content, get a
 * CID back" / "fetch content by CID" / "confirm the backend is reachable".
 *
 * Named distinctly from the verifier package's own `IpfsProvider` type
 * (fetch-only, used by CardVerifier) to avoid confusion where both are
 * imported in the same file (see src/context.ts).
 *
 * Implementations: filebase.ts (production), kubo.ts (local/integration
 * testing, talks directly to a Kubo node), mock.ts (in-memory, unit tests).
 * Selected at startup by src/ipfs/index.ts's createIpfsClient() factory
 * based on PressConfig.IPFS_PROVIDER.
 */
export interface IpfsPinningProvider {
  pinToIPFS(content: Uint8Array): Promise<string>;
  fetchFromIPFS(cid: string): Promise<Uint8Array>;
  /** Called once at startup before the server accepts traffic. Throws on failure. */
  checkHealth(): Promise<void>;
}
