import { describe, it, expect } from 'vitest';
import {
  AppRegistry,
  AppRegistryValidationError,
  validateAppRegistry,
  type AppRegistryFile,
} from './app-registry';

const VALID_APNS_APP = {
  app_id: 'app-ios',
  platform: 'apns' as const,
  wallet_base_url: 'https://wallet.example',
  apns: {
    key_file: '/dev/null',
    key_id: 'ABCD123456',
    team_id: 'WXYZ789012',
    bundle_id: 'org.example.wallet',
    sandbox: true,
  },
};

const VALID_FCM_APP = {
  app_id: 'app-android',
  platform: 'fcm' as const,
  wallet_base_url: 'https://wallet.example',
  fcm: { service_account_file: '/dev/null' },
};

describe('App registry validation (relay_data_model.md §6.3)', () => {
  it('accepts a valid registry with both platforms', () => {
    expect(() =>
      validateAppRegistry({ apps: [VALID_APNS_APP, VALID_FCM_APP] })
    ).not.toThrow();
  });

  it('rejects duplicate app_id', () => {
    expect(() =>
      validateAppRegistry({ apps: [VALID_APNS_APP, { ...VALID_APNS_APP }] })
    ).toThrow(AppRegistryValidationError);
  });

  it('rejects an invalid platform value', () => {
    const bad = { ...VALID_APNS_APP, platform: 'webpush' as unknown as 'apns' };
    expect(() => validateAppRegistry({ apps: [bad] })).toThrow(AppRegistryValidationError);
  });

  it('rejects a non-https wallet_base_url', () => {
    const bad = { ...VALID_APNS_APP, wallet_base_url: 'http://insecure.example' };
    expect(() => validateAppRegistry({ apps: [bad] })).toThrow(AppRegistryValidationError);
  });

  it('rejects platform=apns with missing apns config', () => {
    const bad = { app_id: 'x', platform: 'apns' as const, wallet_base_url: 'https://w' };
    expect(() => validateAppRegistry({ apps: [bad] })).toThrow(AppRegistryValidationError);
  });

  it('rejects platform=apns with incomplete apns config (missing bundle_id)', () => {
    const bad = {
      ...VALID_APNS_APP,
      apns: { ...VALID_APNS_APP.apns, bundle_id: '' },
    };
    expect(() => validateAppRegistry({ apps: [bad] })).toThrow(AppRegistryValidationError);
  });

  it('rejects platform=fcm with missing fcm config', () => {
    const bad = { app_id: 'x', platform: 'fcm' as const, wallet_base_url: 'https://w' };
    expect(() => validateAppRegistry({ apps: [bad] })).toThrow(AppRegistryValidationError);
  });

  it('rejects cross-field mismatch: platform=fcm but apns config present', () => {
    const bad = {
      app_id: 'x',
      platform: 'fcm' as const,
      wallet_base_url: 'https://w',
      fcm: { service_account_file: '/dev/null' },
      apns: VALID_APNS_APP.apns,
    };
    expect(() => validateAppRegistry({ apps: [bad] })).toThrow(AppRegistryValidationError);
  });

  it('rejects cross-field mismatch: platform=apns but fcm config present', () => {
    const bad = {
      ...VALID_APNS_APP,
      fcm: { service_account_file: '/dev/null' },
    };
    expect(() => validateAppRegistry({ apps: [bad] })).toThrow(AppRegistryValidationError);
  });

  it('AppRegistry.get() resolves by app_id after successful construction', () => {
    const file: AppRegistryFile = { apps: [VALID_APNS_APP, VALID_FCM_APP] };
    const registry = new AppRegistry(file);
    expect(registry.get('app-ios')?.platform).toBe('apns');
    expect(registry.get('app-android')?.platform).toBe('fcm');
    expect(registry.get('nonexistent')).toBeUndefined();
    expect(registry.has('app-ios')).toBe(true);
    expect(registry.has('nonexistent')).toBe(false);
  });

  it('two app entries can share the same wallet_base_url (relay_data_model.md §6.2 note)', () => {
    const file: AppRegistryFile = {
      apps: [
        VALID_APNS_APP,
        { ...VALID_FCM_APP, wallet_base_url: VALID_APNS_APP.wallet_base_url },
      ],
    };
    expect(() => new AppRegistry(file)).not.toThrow();
  });
});
