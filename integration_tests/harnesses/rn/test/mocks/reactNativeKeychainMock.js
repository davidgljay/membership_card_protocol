// jest-only fake for `react-native-keychain`, wired via jest.config.js's
// moduleNameMapper rather than a per-file jest.mock() call — sdk-providers-rn
// resolves this package from its own, separate node_modules tree (a sibling
// package, not hoisted into this one), so a jest.mock() registered here
// wouldn't intercept sdk-providers-rn's own require() of it.
// Same shape/behavior as sdk-providers-rn's own
// test/providers/SecureKeyProvider.test.ts mock.

const store = new Map();

module.exports = {
  SECURITY_LEVEL: { SECURE_HARDWARE: 'SECURE_HARDWARE', SECURE_SOFTWARE: 'SECURE_SOFTWARE', ANY: 'ANY' },
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'AccessibleWhenUnlockedThisDeviceOnly' },
  setGenericPassword: async (username, password, options) => {
    store.set(options.service, { username, password });
    return { service: options.service, storage: 'keystore' };
  },
  getGenericPassword: async (options) => {
    const entry = store.get(options.service);
    if (!entry) return false;
    return { service: options.service, ...entry, storage: 'keystore' };
  },
  resetGenericPassword: async (options) => {
    store.delete(options.service);
    return true;
  },
};
