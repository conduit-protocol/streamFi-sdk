# Wallet Adapters Guide

The Conduit SDK uses wallet adapters as the abstraction layer between your app and signature providers. Two adapters ship with the SDK: `KeypairWalletAdapter` for server-side signing, and `WalletConnectAdapter` for browser/mobile wallets.

## Overview

A wallet adapter implements the `Signer` interface:

```ts
interface Signer {
  sign(tx: Transaction): Transaction | void | Promise<Transaction | void>;
  publicKey(): string;
}
```

The SDK calls `sign()` whenever a transaction needs to be signed, and `publicKey()` to get the signer's address.

---

## KeypairWalletAdapter

Use this for server-side applications or Node.js scripts where you control a private key directly.

### When to Use

- Backend services
- Command-line tools
- Server-side signing
- Testing / automation

### When NOT to Use

- Browser / web apps (private key would be exposed)
- Mobile apps
- Any user-facing application

### Initialization

```ts
import { KeypairWalletAdapter } from '@streamfi/sdk';
import { Keypair } from '@stellar/stellar-sdk';

// From a secret seed
const keypair = Keypair.fromSecret('SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');
const adapter = new KeypairWalletAdapter(keypair);

// From a public key (read-only, will throw on sign attempts)
const readOnly = new KeypairWalletAdapter(Keypair.fromPublicKey('GXXXXXX...'));
```

### Usage with ConduitClient

```ts
import { ConduitClient } from '@streamfi/sdk';

const client = new ConduitClient({
  network: 'testnet',
  signer: adapter,  // Pass the adapter here
});

// Now sign and submit operations automatically
const hash = await client.streams.create({
  asset: 'USDC',
  amount: '1000',
  // ...
});
```

### Example: Server-Side Stream Creation

```ts
import { ConduitClient, KeypairWalletAdapter } from '@streamfi/sdk';
import { Keypair } from '@stellar/stellar-sdk';

async function createStreamForUser(recipientAddress: string) {
  const keypair = Keypair.fromSecret(process.env.OPERATOR_SECRET_KEY!);
  const client = new ConduitClient({
    network: 'mainnet',
    signer: new KeypairWalletAdapter(keypair),
  });

  const hash = await client.streams.create({
    asset: 'USDC',
    amount: '10000',
    recipient: recipientAddress,
    startTime: Math.floor(Date.now() / 1000) + 3600,
    endTime: Math.floor(Date.now() / 1000) + 86400,
  });

  console.log(`Stream created: ${hash}`);
}
```

---

## WalletConnectAdapter

Use this for browser and mobile applications, integrating with user-controlled wallets via WalletConnect v2.

### When to Use

- Web / browser applications
- Mobile applications (React Native)
- Dapps where users control their own keys
- Multi-wallet support

### When NOT to Use

- Server-side signing
- Applications that need to sign without user interaction

### Installation

```bash
npm install @walletconnect/sign-client @walletconnect/types
```

### Initialization

```ts
import { WalletConnectAdapter } from '@streamfi/sdk';
import SignClient from '@walletconnect/sign-client';

const client = await SignClient.init({
  projectId: 'YOUR_WALLETCONNECT_PROJECT_ID',
});

const adapter = new WalletConnectAdapter({
  projectId: 'YOUR_WALLETCONNECT_PROJECT_ID',
  chainId: 'stellar:testnet',  // or 'stellar:pubnet', 'stellar:local'
  client,
  metadata: {
    name: 'My StreamFi App',
    description: 'Streaming payments on Stellar',
    url: 'https://myapp.com',
    icons: ['https://myapp.com/icon.png'],
  },
});
```

### Connecting to a Wallet

```ts
async function connectWallet() {
  const { uri, approval } = await client.connect({
    requiredNamespaces: {
      stellar: {
        chains: ['stellar:testnet'],
        methods: ['stellar_signTransaction'],
        events: ['chainChanged', 'accountsChanged'],
      },
    },
  });

  // Display QR code or deep link
  console.log('QR Code URI:', uri);

  // Wait for user approval
  const session = await approval();
  adapter.setSession(session);
}
```

### Handling Session Persistence

Save and restore sessions across page reloads:

```ts
// After successful connection
localStorage.setItem('walletconnect:session', JSON.stringify(session));

// On app load
window.addEventListener('load', () => {
  const savedSession = localStorage.getItem('walletconnect:session');
  if (savedSession) {
    adapter.setSession(JSON.parse(savedSession));
  }
});
```

### Usage with ConduitClient

```ts
const client = new ConduitClient({
  network: 'testnet',
  signer: adapter,  // Pass the adapter
  wallet: adapter,  // Also pass as wallet for network validation
});

// Sign and submit
const hash = await client.streams.create({
  asset: 'USDC',
  amount: '100',
  recipient: 'GXXXXXX...',
  startTime: Math.floor(Date.now() / 1000) + 3600,
  endTime: Math.floor(Date.now() / 1000) + 86400,
});
```

### Example: React Component

```tsx
import React, { useState, useEffect } from 'react';
import { WalletConnectAdapter } from '@streamfi/sdk';
import { ConduitClientProvider } from '@streamfi/react';
import SignClient from '@walletconnect/sign-client';

export function WalletConnect() {
  const [adapter, setAdapter] = useState<WalletConnectAdapter | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    const initAdapter = async () => {
      const client = await SignClient.init({
        projectId: process.env.REACT_APP_WC_PROJECT_ID!,
      });

      const newAdapter = new WalletConnectAdapter({
        projectId: process.env.REACT_APP_WC_PROJECT_ID!,
        chainId: 'stellar:testnet',
        client,
        metadata: {
          name: 'StreamFi Dapp',
          description: 'Streaming payments',
          url: window.location.origin,
          icons: ['/icon.png'],
        },
      });

      // Restore session
      const sessions = client.session.getAll();
      if (sessions.length > 0) {
        newAdapter.setSession(sessions[0]);
        setIsConnected(true);
      }

      setAdapter(newAdapter);
    };

    initAdapter();
  }, []);

  const handleConnect = async () => {
    if (!adapter) return;

    const { uri, approval } = await adapter.connect({
      requiredNamespaces: {
        stellar: {
          chains: ['stellar:testnet'],
          methods: ['stellar_signTransaction'],
          events: [],
        },
      },
    });

    // In a real app, show QR code to user
    console.log('Connect QR:', uri);

    const session = await approval();
    setIsConnected(true);
  };

  if (!adapter) return <div>Initializing...</div>;

  return (
    <ConduitClientProvider
      client={{
        network: 'testnet',
        signer: adapter,
        wallet: adapter,
      }}
    >
      <button onClick={handleConnect} disabled={isConnected}>
        {isConnected ? '✓ Connected' : 'Connect Wallet'}
      </button>
    </ConduitClientProvider>
  );
}
```

### Handling Network Mismatches

The adapter validates the connected wallet's chain against the configured `chainId`:

```ts
// If wallet is connected to 'stellar:pubnet' but adapter expects 'stellar:testnet':
try {
  const adapter = new WalletConnectAdapter({
    chainId: 'stellar:testnet',
    // ...
  });
  await client.streams.create({...});
} catch (err) {
  if (err instanceof Error && err.message.includes('network')) {
    console.error('Wallet is connected to the wrong network');
  }
}
```

---

## Comparison

| Feature | KeypairWalletAdapter | WalletConnectAdapter |
|---------|----------------------|----------------------|
| **Use Case** | Server-side signing | Browser/mobile wallets |
| **Key Storage** | In memory (risky!) | User's wallet device |
| **Signing** | Synchronous | Async (requires user approval) |
| **Network Validation** | None (your responsibility) | Built-in CAIP-2 validation |
| **Multi-Account** | Single keypair | Multiple accounts via WalletConnect |
| **Session Persistence** | N/A | Yes (manual save/restore) |
| **Privacy** | Keys exposed to server | Keys never leave wallet |

---

## Custom Adapters

Implement the `Signer` interface to build custom adapters:

```ts
import type { Signer } from '@streamfi/sdk';
import { Transaction } from '@stellar/stellar-sdk';

export class CustomWalletAdapter implements Signer {
  private publicKey: string;

  constructor(publicKey: string) {
    this.publicKey = publicKey;
  }

  publicKey(): string {
    return this.publicKey;
  }

  async sign(tx: Transaction): Promise<Transaction | void> {
    // Make a request to your custom signing service
    const signedXdr = await fetch('/api/sign', {
      method: 'POST',
      body: JSON.stringify({ xdr: tx.toXDR() }),
    }).then(r => r.json());

    // Reconstruct the signed transaction
    const signedTx = new Transaction(signedXdr, 'some network passphrase');
    return signedTx;
  }
}

// Use it
const adapter = new CustomWalletAdapter('GXXXXXX...');
const client = new ConduitClient({ network: 'testnet', signer: adapter });
```

---

## Best Practices

### 1. Never Expose Private Keys in the Browser

```ts
// ❌ DO NOT DO THIS
const secret = prompt('Enter your secret key:');
const adapter = new KeypairWalletAdapter(Keypair.fromSecret(secret));

// ✓ Use WalletConnect instead
const adapter = new WalletConnectAdapter({ chainId: 'stellar:testnet' });
```

### 2. Restore Sessions on Page Load

```ts
useEffect(() => {
  const savedSession = localStorage.getItem('walletconnect:session');
  if (savedSession) {
    adapter.setSession(JSON.parse(savedSession));
  }
}, []);
```

### 3. Handle Network Mismatches

```ts
// Validate wallet network before operations
if (!adapter.isConnected() || adapter.chainId !== 'stellar:testnet') {
  throw new Error('Please connect to testnet');
}
```

### 4. Gracefully Handle Signing Failures

```ts
try {
  const hash = await client.streams.create({...});
} catch (err) {
  if (err instanceof Error && err.message.includes('user rejected')) {
    console.log('User cancelled signing');
  } else {
    throw err;
  }
}
```

---

## Troubleshooting

### "WalletConnect adapter is not connected"

The adapter has no active session. Call `connect()` first and set the resulting session:

```ts
const { uri, approval } = await adapter.connect({...});
const session = await approval();
adapter.setSession(session);
```

### "Unsupported chainId 'stellar:pubnet'"

The `chainId` must be one of: `stellar:pubnet`, `stellar:testnet`, or `stellar:local`. Check your configuration:

```ts
const adapter = new WalletConnectAdapter({
  chainId: 'stellar:testnet',  // ✓ Valid
  // OR
  chainId: 'stellar:pubnet',   // ✓ Valid
});
```

### "Network mismatch: wallet is on mainnet but app expects testnet"

The user's connected wallet is on a different network than your app. Request they switch networks in their wallet, or:

```ts
const adapter = new WalletConnectAdapter({
  chainId: 'stellar:mainnet',  // Match wallet network
});
```

### "Transaction simulation failed"

The wallet may have insufficient XLM for fees. Ensure the connected account has at least 2 XLM:

```ts
const balance = await client.getAccount(publicKey);
if (balance < 2000000) {  // 2 XLM in stroops
  console.error('Insufficient balance for transaction fees');
}
```
