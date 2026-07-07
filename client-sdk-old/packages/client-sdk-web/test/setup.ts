// jsdom does not implement IndexedDB; fake-indexeddb/auto installs a
// working polyfill (including structured-clone support for CryptoKey
// objects) onto globalThis for every test in this package.
import 'fake-indexeddb/auto';
