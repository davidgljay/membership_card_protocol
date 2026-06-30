/** Shared hashing helpers used across account creation, keyring storage, and federation routing. */

import { keccak_256 } from '@noble/hashes/sha3';

/** keccak256 of a base64url string's decoded bytes, returned as 0x-prefixed hex. */
export function keccak256OfBase64Url(base64url: string): string {
  const bytes = Buffer.from(base64url, 'base64url');
  return '0x' + Buffer.from(keccak_256(bytes)).toString('hex');
}
