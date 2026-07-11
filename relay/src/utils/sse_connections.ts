import type { ServerResponse } from "node:http";

// In-memory map of device_credential → active SSE response object.
// Lost on restart (expected — SSE connections do not survive restarts).
const connections = new Map<string, ServerResponse>();

export function registerSSEConnection(credential: string, res: ServerResponse): void {
  connections.set(credential, res);
}

export function getSSEConnection(credential: string): ServerResponse | undefined {
  return connections.get(credential);
}

export function removeSSEConnection(credential: string): void {
  connections.delete(credential);
}

export function getSSEConnectionCount(): number {
  return connections.size;
}
