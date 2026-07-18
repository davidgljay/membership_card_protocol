/**
 * Factory for the press's IpfsPinningProvider, selected by
 * PressConfig.IPFS_PROVIDER. See provider.ts for the interface and
 * filebase.ts/kubo.ts/mock.ts for implementations.
 */

import type { PressConfig } from '../config.js';
import type { IpfsPinningProvider } from './provider.js';
import { createFilebaseProvider } from './filebase.js';
import { createKuboProvider } from './kubo.js';
import { createMockProvider } from './mock.js';

export type { IpfsPinningProvider } from './provider.js';

export function createIpfsClient(config: PressConfig): IpfsPinningProvider {
  switch (config.IPFS_PROVIDER) {
    case 'filebase':
      return createFilebaseProvider(config);
    case 'kubo':
      return createKuboProvider(config);
    case 'mock':
      return createMockProvider();
  }
}
