/**
 * Output delivery (notary_host.md §12): a `notary_output` routing envelope, already encrypted to one recipient sub-card
 * by the enclave, handed to a wallet service as a sender (`POST /messages`, message_routing.md §Delivery Flow). The host
 * can't read it, and the wallet service sees only `to` and `subcard_hash`.
 *
 * `NOTARY_DELIVERY_URL` is the wallet service the host sends through. If that service answers `410 card_migrated` the card
 * now lives at another wallet service, and the envelope is sent once to the endpoint it names. Looking up a recipient's
 * wallet service in the peer registry (a sender's routing table) is not done here: the host sends through one configured
 * service, which is enough where the operator runs or peers with the recipients' wallet service.
 */
import type { DeliveryClient } from "../services.js";

export function walletDelivery(baseUrl: string, fetchImpl: typeof fetch = fetch): DeliveryClient {
  const send = (base: string, env: unknown) => fetchImpl(`${base.replace(/\/$/, "")}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(env) });
  return {
    async deliver(routingEnvelope) {
      let r = await send(baseUrl, routingEnvelope);
      if (r.status === 410) {
        const moved = (await r.json().catch(() => null)) as { endpoint?: string } | null;
        if (!moved?.endpoint) throw new Error("delivery: 410 card_migrated without an endpoint");
        r = await send(moved.endpoint, routingEnvelope);
      }
      if (r.status !== 202) throw new Error(`delivery refused: HTTP ${r.status}`);
    },
  };
}
