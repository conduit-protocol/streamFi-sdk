/**
 * Example: Implement a custom WalletAdapter for a third-party wallet.
 *
 * The WalletAdapter interface allows StreamFi SDK to support any wallet that
 * can sign Soroban transactions. This example demonstrates a fictional
 * "MyCustomWallet" to show the complete pattern:
 *
 * 1. Implement the WalletAdapter interface
 * 2. Connect/disconnect from the wallet
 * 3. Sign transactions
 * 4. Integrate with ConduitClient
 *
 * Real implementations would replace the stub wallet logic with actual
 * connections to services like WalletConnect, browser extensions, mobile RPC,
 * or hardware wallets.
 */

import { ConduitClient } from '../src/index.js';
import { WalletAdapter, SignTransactionOptions } from '../src/adapters/types.js';
import { Transaction } from '@stellar/stellar-sdk';

/**
 * Fictional "MyCustomWallet" implementation.
 *
 * A real wallet would communicate with a backend service, browser extension,
 * mobile app, or hardware wallet to perform these operations.
 */
class MyCustomWalletAdapter implements WalletAdapter {
  private connectedPublicKey: string | null = null;
  private walletBackendUrl: string;

  constructor(options: { backendUrl: string }) {
    this.walletBackendUrl = options.backendUrl;
  }

  /**
   * Check if the wallet is currently connected.
   */
  isConnected(): boolean {
    return this.connectedPublicKey !== null;
  }

  /**
   * Connect to the wallet and retrieve the active account's public key.
   * This might prompt the user in a real wallet implementation.
   */
  async connect(): Promise<string> {
    console.log('Connecting to MyCustomWallet...');

    // In a real implementation, this would:
    // 1. Open a connection to a wallet backend (WebSocket, iframe, etc.)
    // 2. Request the user to authorize
    // 3. Return the user's public key
    try {
      const response = await fetch(`${this.walletBackendUrl}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`Connection failed: ${response.statusText}`);
      }

      const { publicKey } = await response.json() as { publicKey: string };
      this.connectedPublicKey = publicKey;

      console.log(`Connected to MyCustomWallet: ${publicKey}`);
      return publicKey;
    } catch (err) {
      throw new Error(`Failed to connect: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Disconnect from the wallet.
   */
  async disconnect(): Promise<void> {
    if (!this.isConnected()) {
      return;
    }

    console.log('Disconnecting from MyCustomWallet...');

    // In a real implementation, this would close the connection.
    try {
      await fetch(`${this.walletBackendUrl}/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey: this.connectedPublicKey }),
      });
    } catch (err) {
      console.warn(`Disconnect warning: ${err instanceof Error ? err.message : String(err)}`);
    }

    this.connectedPublicKey = null;
    console.log('Disconnected from MyCustomWallet');
  }

  /**
   * Get the current account's public key.
   * Returns synchronously if connected, or throws if not.
   */
  getPublicKey(): string | Promise<string> {
    if (!this.connectedPublicKey) {
      throw new Error(
        'MyCustomWallet is not connected. Call connect() first.'
      );
    }
    return this.connectedPublicKey;
  }

  /**
   * Sign a Soroban transaction.
   *
   * In a real wallet, this would:
   * 1. Validate the transaction (optional)
   * 2. Display it to the user for approval
   * 3. Forward to the wallet backend for signing
   * 4. Return the signed transaction
   */
  async signTransaction(
    tx: Transaction | string,
    opts?: SignTransactionOptions,
  ): Promise<Transaction | string> {
    if (!this.isConnected()) {
      throw new Error(
        'MyCustomWallet is not connected. Call connect() first.'
      );
    }

    const isXdrString = typeof tx === 'string';
    const txXdr = isXdrString ? tx : (tx as Transaction).toXDR();

    console.log(`Requesting signature from MyCustomWallet...`);

    // In a real implementation, this would forward the transaction to the wallet
    // backend over a secure channel (WebSocket, iframe postMessage, etc.).
    try {
      const response = await fetch(`${this.walletBackendUrl}/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicKey: this.connectedPublicKey,
          transactionXdr: txXdr,
          networkPassphrase: opts?.networkPassphrase,
        }),
      });

      if (!response.ok) {
        throw new Error(`Signing failed: ${response.statusText}`);
      }

      const { signedTransactionXdr } = await response.json() as { signedTransactionXdr: string };

      console.log('Transaction signed by MyCustomWallet');

      // Return in the same format as the input (XDR string or Transaction object).
      if (isXdrString) {
        return signedTransactionXdr;
      }

      return new Transaction(signedTransactionXdr, opts?.networkPassphrase ?? '');
    } catch (err) {
      throw new Error(
        `Failed to sign transaction: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Optional: expose the current network/chain ID.
   * Useful if the wallet validates that operations match its configured network.
   */
  chainId?: string;
}

/**
 * Example usage: integrating the custom wallet adapter with ConduitClient.
 */
async function main(): Promise<void> {
  // Initialize the custom wallet adapter with your backend URL.
  const walletAdapter = new MyCustomWalletAdapter({
    backendUrl: 'http://localhost:3000/wallet-api',
  });

  try {
    // Connect to the wallet (this will prompt the user or initialize the connection).
    const publicKey = await walletAdapter.connect();
    console.log(`Active account: ${publicKey}\n`);

    // Initialize ConduitClient with the custom wallet adapter.
    const client = new ConduitClient({
      network: 'testnet',
      walletAdapter,
      factoryAddress: 'CCORRECT000FACTORY00ADDRESS000000000000000000000000000000',
    });

    // Now you can use the client to create streams, withdraw, etc.
    // All transactions will be signed by MyCustomWallet.

    console.log('Creating a stream with MyCustomWallet...');
    const result = await client.streams.create({
      recipient: 'GABC1234RECIPIENTADDRESSEXAMPLE000000000000000000000000',
      token: 'native',
      depositAmount: '100',
      durationSeconds: 3600,
    });

    console.log(`Stream created: ${result.streamId}`);
    console.log(`Transaction: ${result.txHash}`);

    // Always disconnect when done.
    await walletAdapter.disconnect();
  } catch (err) {
    console.error('Error:', err);
    try {
      await walletAdapter.disconnect();
    } catch (disconnectErr) {
      console.warn('Cleanup error:', disconnectErr);
    }
    process.exit(1);
  }
}

/**
 * Pattern for building a custom wallet adapter:
 *
 * 1. Define the wallet connection interface
 *    - How to initialize (URL, config, etc.)
 *    - How to connect/disconnect
 *    - How to expose the public key
 *
 * 2. Implement WalletAdapter interface
 *    - getPublicKey() — returns the account public key
 *    - signTransaction() — signs a transaction
 *    - isConnected() — checks connection status
 *    - connect() / disconnect() — optional, for manual control
 *
 * 3. Error handling
 *    - Throw meaningful errors if not connected
 *    - Wrap backend errors with context
 *    - Validate inputs before forwarding to backend
 *
 * 4. Integrate with ConduitClient
 *    - Pass walletAdapter to ConduitClient constructor
 *    - All streams operations now use the custom wallet
 *
 * Common wallet types:
 * - Browser extension (e.g., Freighter) — use contentScript messaging
 * - WalletConnect v2 — use WalletConnect SDK (WalletConnectAdapter exists in SDK)
 * - Mobile wallet — use deep linking or WalletConnect
 * - Hardware wallet — use device communication library
 * - Custodial backend — use HTTP API with auth tokens
 */

// Uncomment to run:
// main().catch(err => { console.error(err); process.exit(1); });

// Export for use in other modules.
export { MyCustomWalletAdapter };
