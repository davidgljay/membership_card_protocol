# harnesses/rn/

Jest + `react-native` preset harness exercising `sdk-providers-rn` +
`app-sdk`/`wallet-sdk` against the live stack. Same smoke test as
`harnesses/web/`: create wallet → accept an offer → register a device
sub-card → validate the resulting card.

No emulator (`integration-testing-implementation-plan.md` §2.3's decision).
Runs directly under jest/node — `AsyncStorageProvider`/`SecureEnclaveKeyProvider`
are the real `sdk-providers-rn` implementations with their native modules
(`@react-native-async-storage/async-storage`, `react-native-keychain`)
mocked at the jest level (`jest.config.js`'s `moduleNameMapper`, same
fakes as `sdk-providers-rn`'s own unit tests). `PasskeyProvider` is a
hand-rolled fake (`src/mockPasskeyProvider.ts`) — a WebAuthn ceremony
can't be meaningfully simulated without a browser or real hardware, and
`react-native-passkey`'s bridge needs one of those.

```bash
npm install
npm test
```

Requires the `integration_tests` stack to be up (`docker compose up -d`
from `integration_tests/`) and `contracts/deployments/local.json` to exist.

Filled in during Phase 2 (`integration-testing-implementation-plan.md` §2.3).
