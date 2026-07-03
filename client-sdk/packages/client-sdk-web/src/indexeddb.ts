/**
 * Shared IndexedDB plumbing for the web package's storage-backed providers
 * (`IndexedDBStorageProvider`, `WebCryptoSecureKeyProvider`). One database,
 * two object stores — kept internal to this package; callers only ever see
 * the provider interfaces from `@membership-card-protocol/client-sdk`.
 */

const DB_NAME = 'membership-card-protocol-client-sdk';
const DB_VERSION = 1;

export const KV_STORE = 'kv';
export const SECURE_KEY_STORE = 'secure-keys';
export const LOCK_STORE = 'multi-instance-locks';

let dbPromise: Promise<IDBDatabase> | undefined;

export function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE);
      if (!db.objectStoreNames.contains(SECURE_KEY_STORE)) db.createObjectStore(SECURE_KEY_STORE);
      if (!db.objectStoreNames.contains(LOCK_STORE)) db.createObjectStore(LOCK_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error as Error);
  });
  return dbPromise;
}

export function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error as Error);
  });
}

export async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const db = await openDb();
  const tx = db.transaction(store, 'readonly');
  return promisifyRequest<T | undefined>(tx.objectStore(store).get(key));
}

export async function idbPut<T>(store: string, key: string, value: T): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  await promisifyRequest(tx.objectStore(store).put(value, key));
}

export async function idbDelete(store: string, key: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  await promisifyRequest(tx.objectStore(store).delete(key));
}
