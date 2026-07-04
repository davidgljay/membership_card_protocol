export { setupWallet, type WalletSetupOptions, type WalletSetupResult } from './setupWallet.js';
export { deriveDecryptionKey, devicePasskeyOutputFromRegistration } from './kdf.js';
export {
  encryptKeyring,
  decryptKeyring,
  computeKeyringId,
  type KeyringEntry,
} from './keyring.js';
export {
  registerDeviceSubCard,
  type WalletAppCardIdentity,
  type RegisterSubCardFn,
  type RegisterSubCardResult,
  type SubCardDocumentFields,
  type SignedSubCardDocument,
  type RegisterDeviceSubCardOptions,
  type DeviceSubCardResult,
} from './deviceSubCard.js';
