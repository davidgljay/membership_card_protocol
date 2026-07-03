// Redis key-schema helpers — relay_data_model.md §2.1 (UUID store), §3.1
// (message store), §4.1 (delete queue), §8.2 (device credential store).
// Centralized so the exact key format is defined once, not duplicated
// across storage-layer call sites.

export function uuidKey(uuid: string): string {
  return `uuid:${uuid}`;
}

export function credentialKey(deviceCredential: string): string {
  return `cred:${deviceCredential}`;
}

export function messagesKey(deviceCredential: string): string {
  return `messages:${deviceCredential}`;
}

export const PENDING_DELETES_KEY = 'pending_deletes';

export const UUID_SCAN_PATTERN = 'uuid:*';
