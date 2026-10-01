export type { WalletAdapter, SignTransactionOptions } from './types.js';

/** A browser wallet that was detected in the current environment. */
export interface AvailableWallet {
  id: 'freighter' | 'albedo';
  name: 'Freighter' | 'Albedo';
  /** The adapter class to instantiate after the user selects this wallet. */
  adapter: typeof FreighterWalletAdapter | typeof AlbedoWalletAdapter;
}

export { KeypairWalletAdapter } from './keypair.js';
export {
  WalletConnectAdapter,
  type WalletConnectAdapterOptions,
  type WalletConnectAppMetadata,
  type WalletConnectSessionChange,
} from './walletconnect.js';
export {
  FreighterWalletAdapter,
  type FreighterWalletAdapterOptions,
  type FreighterApi,
  type FreighterNetworkDetails,
} from './freighter.js';
export {
  AlbedoWalletAdapter,
  type AlbedoWalletAdapterOptions,
  type AlbedoApi,
  type AlbedoPublicKeyResult,
  type AlbedoTxResult,
} from './albedo.js';

import { FreighterWalletAdapter } from './freighter.js';
import { AlbedoWalletAdapter } from './albedo.js';

/**
 * Detect browser wallet APIs without requesting access or opening a prompt.
 *
 * The function is asynchronous so wallet pickers can use it alongside other
 * connection discovery work. It is safe to call during SSR; in that case it
 * resolves to an empty list.
 */
export async function detectAvailableWallets(): Promise<AvailableWallet[]> {
  if (typeof globalThis === 'undefined') return [];

  const scope = globalThis as typeof globalThis & {
    freighter?: unknown;
    stellar?: unknown;
    albedo?: unknown;
  };
  const wallets: AvailableWallet[] = [];

  if (scope.freighter || scope.stellar) {
    wallets.push({ id: 'freighter', name: 'Freighter', adapter: FreighterWalletAdapter });
  }
  if (scope.albedo) {
    wallets.push({ id: 'albedo', name: 'Albedo', adapter: AlbedoWalletAdapter });
  }

  return wallets;
}
