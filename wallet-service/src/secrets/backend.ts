/**
 * SecretsBackend: wraps/unwraps a per-account DEK using a master key.
 * Two implementations exist (strategic-plan.md §Secret Storage):
 *
 *  - WebCryptoBackend (default): master key is a platform secret, used
 *    directly with the runtime's Web Crypto API. No external service call,
 *    no AWS dependency. Selected for all presets by default.
 *  - KmsBackend (opt-in): calls AWS KMS Encrypt/Decrypt. Trades an AWS
 *    dependency for a logged, IAM-gated decrypt call kept in a separate
 *    credential domain from the application secret.
 *
 * Both only ever see the DEK, never the service_secret plaintext itself —
 * that envelope is handled one layer up in SecretsService.
 */

export interface SecretsBackend {
  wrapDek(dek: Buffer): Promise<string>;
  unwrapDek(dekEnc: string): Promise<Buffer>;
}
