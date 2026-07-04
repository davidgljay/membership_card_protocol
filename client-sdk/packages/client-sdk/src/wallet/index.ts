export { setupWallet, type WalletSetupOptions, type WalletSetupResult } from './setupWallet.js';
export { deriveDecryptionKey, devicePasskeyOutputFromRegistration, syncedPasskeyOutputFromPrf } from './kdf.js';
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
export {
  wrapDecryptionKey,
  unwrapDecryptionKey,
  registerBackup,
  type BackupType,
  type NotificationChannels,
  type RegisterBackupOptions,
  type BackupRegistrationResult,
} from './backupRegistration.js';
export {
  initiateRecovery,
  cancelRecovery,
  releaseRecoveryKey,
  fetchKeyringBlob,
  recoverWallet,
  type RecoveryMethod,
  type InitiateRecoveryResult,
  type CancelRecoveryResult,
  type ReleaseRecoveryKeyOutcome,
  type RecoverWalletOptions,
  type RecoverWalletResult,
} from './recovery.js';
