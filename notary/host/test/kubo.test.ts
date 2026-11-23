/** The Kubo client: requests and the checks it makes (unit, with an injected fetch), and a live run when KUBO_API_URL is set. */
import { describe, it, expect } from "vitest";
import { cidOfBytes } from "@membership-card-protocol/wallet-sdk/notary-types";
import { kuboIpfs } from "../src/ipfs/kubo.js";
import { pinExact } from "../src/ipfs/index.js";

const bytes = new TextEncoder().encode('{"hello":"notary"}');
const cid = cidOfBytes(bytes);
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

describe("kuboIpfs (injected fetch)", () => {
  it("adds with the raw-codec parameters and returns Kubo's hash", async () => {
    let url = "";
    const ipfs = kuboIpfs("http://kubo:5001/", (async (u: string) => { url = u; return json({ Hash: cid }); }) as never);
    expect(await ipfs.pin(bytes)).toBe(cid);
    expect(url).toContain("cid-version=1");
    expect(url).toContain("raw-leaves=true");
    expect(url).toContain("hash=sha2-256");
    expect(url).toContain("pin=true");
  });
  it("pinExact refuses a node that answers with another CID (e.g. a DAG-PB wrapper)", async () => {
    const ipfs = kuboIpfs("http://kubo", (async () => json({ Hash: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" })) as never);
    await expect(pinExact(ipfs, bytes)).rejects.toThrow(/raw-codec CID/);
  });
  it("fetch returns the bytes when their digest is the CID's", async () => {
    const ipfs = kuboIpfs("http://kubo", (async () => new Response(bytes)) as never);
    expect(await ipfs.fetch(cid)).toEqual(bytes);
  });
  it("fetch refuses bytes that are not the CID's (a lying node)", async () => {
    const ipfs = kuboIpfs("http://kubo", (async () => new Response(new TextEncoder().encode("something else"))) as never);
    await expect(ipfs.fetch(cid)).rejects.toThrow(/not bafk/);
  });
  it("fetch is null when Kubo cannot find the block, and throws on other errors", async () => {
    expect(await kuboIpfs("http://kubo", (async () => json({ Message: "not found" }, 500)) as never).fetch(cid)).toBeNull();
    await expect(kuboIpfs("http://kubo", (async () => json({}, 403)) as never).fetch(cid)).rejects.toThrow(/403/);
  });
});

const live = process.env["KUBO_API_URL"];
describe.skipIf(!live)("kuboIpfs (live Kubo at KUBO_API_URL)", () => {
  it("pins exact bytes under their raw-codec CID and reads them back", async () => {
    const ipfs = kuboIpfs(live!);
    const payload = new TextEncoder().encode(`{"n":"${Math.random()}"}`);
    const got = await pinExact(ipfs, payload);
    expect(got).toBe(cidOfBytes(payload));
    expect(await ipfs.fetch(got)).toEqual(payload);
  });
  it("an unknown CID is null", async () => {
    expect(await kuboIpfs(live!).fetch(cidOfBytes(new TextEncoder().encode("never pinned " + Math.random())))).toBeNull();
  }, 60_000);
});
