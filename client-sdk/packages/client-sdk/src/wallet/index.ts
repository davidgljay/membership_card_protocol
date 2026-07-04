export { setupWallet, type WalletSetupOptions, type WalletSetupResult } from './setupWallet.js';
export { deriveDecryptionKey, devicePasskeyOutputFromRegistration } from './kdf.js';
export {
  encryptKeyring,
  decryptKeyring,
  computeKeyringId,
  type KeyringEntry,
} from './keyring.js';
