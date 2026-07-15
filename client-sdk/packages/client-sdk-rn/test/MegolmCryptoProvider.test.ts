import {
  UnimplementedRNMegolmCryptoProvider,
  MegolmCryptoProviderNotImplementedError,
} from '../src/MegolmCryptoProvider.js';

/**
 * `UnimplementedRNMegolmCryptoProvider` is a scaffold, not a working
 * provider (Matrix Phase 5, Step 18 — see that file's header comment for
 * exactly what's missing: the Rust build pipeline against
 * `matrix-sdk-crypto-ffi`, `uniffi-bindgen-react-native` codegen, and
 * native iOS/Android Turbo Module packaging, none of which is buildable
 * or testable in this sandbox). This test only confirms the honest-gap
 * contract: every method throws a specific, descriptive error rather than
 * silently succeeding or returning fabricated data — it does not and
 * cannot test any real Megolm/Olm behavior on React Native.
 */
describe('UnimplementedRNMegolmCryptoProvider', () => {
  const provider = new UnimplementedRNMegolmCryptoProvider();

  it('flushOutgoingRequests throws MegolmCryptoProviderNotImplementedError', async () => {
    await expect(provider.flushOutgoingRequests()).rejects.toThrow(MegolmCryptoProviderNotImplementedError);
  });

  it('receiveSync throws MegolmCryptoProviderNotImplementedError', async () => {
    await expect(
      provider.receiveSync({ toDeviceEvents: [], changedDeviceUserIds: [], leftDeviceUserIds: [], oneTimeKeyCounts: {} })
    ).rejects.toThrow(MegolmCryptoProviderNotImplementedError);
  });

  it('ensureRoomSession throws MegolmCryptoProviderNotImplementedError', async () => {
    await expect(provider.ensureRoomSession('!room:example.org', [])).rejects.toThrow(
      MegolmCryptoProviderNotImplementedError
    );
  });

  it('encryptRoomEvent throws MegolmCryptoProviderNotImplementedError', async () => {
    await expect(provider.encryptRoomEvent('!room:example.org', 'm.room.message', {})).rejects.toThrow(
      MegolmCryptoProviderNotImplementedError
    );
  });

  it('decryptRoomEvent throws MegolmCryptoProviderNotImplementedError', async () => {
    await expect(
      provider.decryptRoomEvent('!room:example.org', {
        type: 'm.room.encrypted',
        sender: '@alice:example.org',
        event_id: '$1',
        origin_server_ts: 0,
        content: {},
      })
    ).rejects.toThrow(MegolmCryptoProviderNotImplementedError);
  });

  it('each error message names the specific unimplemented method', async () => {
    await expect(provider.encryptRoomEvent('!room:example.org', 'm.room.message', {})).rejects.toThrow(
      /encryptRoomEvent/
    );
  });
});
