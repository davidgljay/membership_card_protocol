/**
 * Jest-only `PasskeyProvider` fake — per integration-testing-implementation-
 * plan.md 2.3's "jest-only RN simulation, no emulator" decision. A WebAuthn
 * ceremony can't be meaningfully simulated without a browser (the web
 * harness leans on Chrome's CDP virtual authenticator for this, see
 * harnesses/web/test/smoke.spec.ts) or real device hardware; `react-native-
 * passkey`'s real bridge needs one or the other and isn't usable under
 * plain jest.
 *
 * Not a WebAuthn implementation — no real attestation/assertion signature,
 * no COSE key. Callers in this codebase never cryptographically verify
 * `attestationObject`/`clientDataJSON`/`signature` (see setupWallet.ts:
 * `webauthn_public_key` is stored as an opaque attestation blob; wallet-
 * service's account-creation route only checks these fields are present,
 * never their content — confirmed against
 * wallet-service/src/routes/accounts-create.ts). What *is* load-bearing is
 * `prfOutput`: setupWallet.ts hard-requires it (throws otherwise —
 * `kdf.ts`'s `passkeyOutputFromPrf` has no fallback) and it must be the
 * same value on every `assert()` against a given credential, matching the
 * WebAuthn PRF extension's real deterministic-per-credential property
 * (`wallet_sdk.md` line 139-142). This fake honors exactly that: each
 * registered credential gets one fixed prfOutput, keccak256-derived from
 * its credentialId, returned identically by every later `assert()`.
 */

import { keccak256 } from '@membership-card-protocol/app-sdk';
import type { PasskeyProvider } from '@membership-card-protocol/app-sdk';

interface FakeCredential {
  prfOutput: Uint8Array;
}

export class MockPasskeyProvider implements PasskeyProvider {
  readonly #credentials = new Map<string, FakeCredential>();

  async register(challenge: Uint8Array): ReturnType<PasskeyProvider['register']> {
    const credentialId = crypto.getRandomValues(new Uint8Array(16));
    const credentialIdHex = Buffer.from(credentialId).toString('hex');
    // Deterministic, credential-bound "PRF output" — real WebAuthn PRF is a
    // pseudorandom function of the credential's own key material and a
    // caller-supplied salt; keccak256(credentialId) is a stand-in with the
    // one property that matters here (fixed per credential, unguessable
    // from the challenge alone).
    const prfOutput = keccak256Bytes(credentialId);
    this.#credentials.set(credentialIdHex, { prfOutput });

    return {
      credentialId,
      attestationObject: fakeBytes('attestation', challenge),
      clientDataJSON: fakeClientDataJSON('webauthn.create', challenge),
      prfOutput,
    };
  }

  async assert(
    challenge: Uint8Array,
    credentialId?: Uint8Array
  ): ReturnType<PasskeyProvider['assert']> {
    const resolvedId = credentialId ?? this.#credentials.keys().next().value;
    if (!resolvedId) {
      throw new Error('MockPasskeyProvider.assert: no registered credential to assert against');
    }
    const idHex = typeof resolvedId === 'string' ? resolvedId : Buffer.from(resolvedId).toString('hex');
    const credential = this.#credentials.get(idHex);
    if (!credential) {
      throw new Error(`MockPasskeyProvider.assert: unknown credentialId ${idHex}`);
    }

    return {
      credentialId: credentialId ?? Buffer.from(idHex, 'hex'),
      authenticatorData: fakeBytes('authenticator-data', challenge),
      clientDataJSON: fakeClientDataJSON('webauthn.get', challenge),
      signature: fakeBytes('signature', challenge),
      prfOutput: credential.prfOutput,
    };
  }
}

function keccak256Bytes(input: Uint8Array): Uint8Array {
  const hex = keccak256(input); // unprefixed hex string, per app-sdk's keccak256 doc
  return Buffer.from(hex, 'hex');
}

function fakeBytes(label: string, challenge: Uint8Array): Uint8Array {
  return keccak256Bytes(new TextEncoder().encode(`${label}:${Buffer.from(challenge).toString('base64url')}`));
}

function fakeClientDataJSON(type: string, challenge: Uint8Array): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      type,
      challenge: Buffer.from(challenge).toString('base64url'),
      origin: 'mock://integration-tests.local',
    })
  );
}
