import { describe, it, expect } from 'vitest';
import {
  ObliviousTargetRegistry,
  ObliviousTargetsValidationError,
  validateObliviousTargets,
  type ObliviousTargetsFile,
} from './oblivious-targets';

const WALLET_SERVICE_TARGET = {
  target_id: 'wallet-service-1',
  ohttp_gateway_url: 'https://wallet.example/ohttp/gateway',
};

const PRESS_TARGET = {
  target_id: 'press-1',
  ohttp_gateway_url: 'https://press.example/ohttp/gateway',
};

describe('Oblivious-targets registry validation (client-sdk implementation plan Step 1.4b)', () => {
  it('accepts a valid registry mixing a wallet-service-shaped and a press-shaped entry', () => {
    expect(() =>
      validateObliviousTargets({ targets: [WALLET_SERVICE_TARGET, PRESS_TARGET] })
    ).not.toThrow();
  });

  it('rejects duplicate target_id', () => {
    expect(() =>
      validateObliviousTargets({ targets: [WALLET_SERVICE_TARGET, { ...WALLET_SERVICE_TARGET }] })
    ).toThrow(ObliviousTargetsValidationError);
  });

  it('rejects a non-https ohttp_gateway_url', () => {
    const bad = { ...WALLET_SERVICE_TARGET, ohttp_gateway_url: 'http://insecure.example/ohttp' };
    expect(() => validateObliviousTargets({ targets: [bad] })).toThrow(
      ObliviousTargetsValidationError
    );
  });

  it('ObliviousTargetRegistry.get resolves a known target_id and returns undefined for an unknown one', () => {
    const file: ObliviousTargetsFile = { targets: [WALLET_SERVICE_TARGET, PRESS_TARGET] };
    const registry = new ObliviousTargetRegistry(file);
    expect(registry.get('wallet-service-1')).toEqual(WALLET_SERVICE_TARGET);
    expect(registry.get('press-1')).toEqual(PRESS_TARGET);
    expect(registry.get('unknown-target')).toBeUndefined();
  });

  it('the ObliviousTargetRegistry constructor validates eagerly', () => {
    expect(
      () => new ObliviousTargetRegistry({ targets: [{ ...WALLET_SERVICE_TARGET }, { ...WALLET_SERVICE_TARGET }] })
    ).toThrow(ObliviousTargetsValidationError);
  });
});
