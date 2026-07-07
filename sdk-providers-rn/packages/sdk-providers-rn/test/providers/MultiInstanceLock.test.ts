import { NoopMultiInstanceLock } from '../../src/MultiInstanceLock.js';

/**
 * NoopMultiInstanceLock deliberately does NOT satisfy the full Step 1.2
 * `multiInstanceLockContractTests` suite — that suite's "a second acquire
 * waits until the first is released" case assumes mutual exclusion, which
 * is exactly what RN doesn't need (OQ-SDK-8: multi-instance coordination
 * is a web-only, multi-tab concern; RN's single-foreground-instance model
 * has nothing to coordinate). Running the generic suite against this
 * provider would fail by design, not by bug, so it's tested directly
 * against what it actually promises instead.
 */
describe('NoopMultiInstanceLock', () => {
  it('acquire resolves immediately with a release function', async () => {
    const lock = new NoopMultiInstanceLock();
    const release = await lock.acquire('any-name');
    expect(typeof release).toBe('function');
    release();
  });

  it('never blocks — two concurrent acquires of the same name both resolve without waiting', async () => {
    const lock = new NoopMultiInstanceLock();
    const release1 = await lock.acquire('any-name');
    const release2 = await lock.acquire('any-name');
    release1();
    release2();
  });
});
