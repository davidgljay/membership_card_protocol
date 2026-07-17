import type { WebSocket } from "ws";

// In-memory map of device_credential → active WebSocket connection.
// Lost on restart (expected — WebSocket connections do not survive restarts).
//
// Keyed by device_credential, not by the UUID that was used to open the
// connection (relay_data_model.md §8, process_specs/notification_relay.md
// Process 3 step 6: "the relay detects the active WebSocket connection for
// this device credential"). This mirrors sse_connections.ts exactly, and for
// the same reason: the UUID that opens GET /ws/{uuid} is consumed by opening
// the connection and is never itself the target of a later POST
// /deliver/{uuid} call — the wallet always delivers to a *different*, still-
// unused UUID from the device's pool, and the relay must look up "is there a
// live connection for this device" by device_credential to find it.
// (Corrected 2026-07-16: relay.md §7.3 was updated in this initiative's
// Phase 2 to describe device_credential-keyed addressing, matching this
// code — the earlier UUID-keyed description this comment used to reference
// no longer exists in the spec.)
const connections = new Map<string, WebSocket>();

export function registerWsConnection(credential: string, ws: WebSocket): void {
  connections.set(credential, ws);
}

export function getWsConnection(credential: string): WebSocket | undefined {
  return connections.get(credential);
}

export function removeWsConnection(credential: string): void {
  connections.delete(credential);
}

export function getWsConnectionCount(): number {
  return connections.size;
}
