import type { MultiInstanceLock } from '@membership-card-protocol/client-sdk';
import { LOCK_STORE, openDb, promisifyRequest } from './indexeddb.js';

interface LockRecord {
  heldBy: string | null;
}

const RELEASE_POLL_FALLBACK_MS = 50;

/**
 * Default web `MultiInstanceLock` (OQ-SDK-8): cross-tab mutex.
 *
 * BroadcastChannel messages have no atomicity guarantee across concurrent
 * senders, so it isn't the source of truth for lock ownership here — an
 * IndexedDB transaction is, since a single `get`-then-`put` within one
 * IndexedDB transaction is serializable across tabs (that guarantee is
 * exactly why IndexedDB exists). BroadcastChannel is used only to wake up
 * waiting tabs immediately on release, instead of polling; a short
 * fallback poll interval covers a missed or coalesced broadcast.
 */
export class BroadcastChannelMultiInstanceLock implements MultiInstanceLock {
  async acquire(name: string): Promise<() => void> {
    const instanceId = crypto.randomUUID();
    const channel = new BroadcastChannel(`client-sdk-lock:${name}`);

    while (!(await this.#tryAcquire(name, instanceId))) {
      await this.#waitForRelease(channel, name);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      void this.#release(name, instanceId, channel);
    };
  }

  async #tryAcquire(name: string, instanceId: string): Promise<boolean> {
    const db = await openDb();
    const tx = db.transaction(LOCK_STORE, 'readwrite');
    const store = tx.objectStore(LOCK_STORE);
    const current = await promisifyRequest<LockRecord | undefined>(store.get(name));
    if (current?.heldBy) {
      return false;
    }
    await promisifyRequest(store.put({ heldBy: instanceId } satisfies LockRecord, name));
    return true;
  }

  async #release(name: string, instanceId: string, channel: BroadcastChannel): Promise<void> {
    const db = await openDb();
    const tx = db.transaction(LOCK_STORE, 'readwrite');
    const store = tx.objectStore(LOCK_STORE);
    const current = await promisifyRequest<LockRecord | undefined>(store.get(name));
    if (current?.heldBy === instanceId) {
      await promisifyRequest(store.put({ heldBy: null } satisfies LockRecord, name));
    }
    channel.postMessage({ type: 'released', name });
    channel.close();
  }

  #waitForRelease(channel: BroadcastChannel, name: string): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        channel.removeEventListener('message', onMessage);
        resolve();
      };
      const onMessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; name?: string } | undefined;
        if (data?.type === 'released' && data.name === name) settle();
      };
      const timer = setTimeout(settle, RELEASE_POLL_FALLBACK_MS);
      channel.addEventListener('message', onMessage);
    });
  }
}
