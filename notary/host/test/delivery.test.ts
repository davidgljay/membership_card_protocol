/** The production delivery client: a routing envelope handed to a wallet service (`POST /messages`), and what it refuses. */
import { describe, it, expect } from "vitest";
import { walletDelivery } from "../src/delivery/wallet.js";

const env = { to: "ab".repeat(32), subcard_hash: "cd".repeat(32), payload: "c2VhbGVk" };
const reply = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });

describe("walletDelivery", () => {
  it("posts the routing envelope unchanged to /messages, and 202 is delivered", async () => {
    const seen: { url: string; body: string }[] = [];
    const d = walletDelivery("http://ws:3000/", (async (url: string, init: RequestInit) => { seen.push({ url, body: String(init.body) }); return reply(202); }) as never);
    await d.deliver(env);
    expect(seen).toEqual([{ url: "http://ws:3000/messages", body: JSON.stringify(env) }]);
  });
  it("a migrated card (410) is sent once to the endpoint it names", async () => {
    const urls: string[] = [];
    const d = walletDelivery("http://a", (async (url: string) => { urls.push(url); return urls.length === 1 ? reply(410, { error: "card_migrated", endpoint: "http://b" }) : reply(202); }) as never);
    await d.deliver(env);
    expect(urls).toEqual(["http://a/messages", "http://b/messages"]);
  });
  it("it does not chase a second redirect", async () => {
    const d = walletDelivery("http://a", (async () => reply(410, { endpoint: "http://b" })) as never);
    await expect(d.deliver(env)).rejects.toThrow(/HTTP 410/);
  });
  it("an unknown recipient (404), a bad envelope (400) and a 410 with no endpoint are errors, not silent drops", async () => {
    for (const r of [reply(404), reply(400)]) await expect(walletDelivery("http://a", (async () => r) as never).deliver(env)).rejects.toThrow(/refused/);
    await expect(walletDelivery("http://a", (async () => reply(410, {})) as never).deliver(env)).rejects.toThrow(/without an endpoint/);
  });
});
