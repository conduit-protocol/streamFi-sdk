import { useState } from 'react';
import { StreamFiProvider } from '@streamfi/react';
import { KeypairWalletAdapter } from '@conduit-protocol/sdk';
import { Keypair } from '@stellar/stellar-sdk';
import StreamList from './components/StreamList';
import CreateStreamForm from './components/CreateStreamForm';
import './App.css';

/**
 * Minimal React Dashboard using @streamfi/react hooks.
 *
 * This example demonstrates:
 * 1. StreamFiProvider setup with a wallet adapter
 * 2. useStreamList hook to fetch and display streams
 * 3. useCreateStream hook to create new streams
 * 4. useWithdrawStream hook for withdrawals
 * 5. Error boundary patterns for SDK errors
 *
 * To run:
 *   1. Set VITE_STELLAR_SECRET and VITE_FACTORY_ADDRESS in .env.local
 *   2. npm install
 *   3. npm run dev
 *   4. Open http://localhost:5173
 */

function App() {
  const [showCreateForm, setShowCreateForm] = useState(false);

  // Load configuration from environment variables.
  const secret = import.meta.env.VITE_STELLAR_SECRET;
  const factoryAddress = import.meta.env.VITE_FACTORY_ADDRESS;

  if (!secret || !factoryAddress) {
    return (
      <div className="error-container">
        <h1>Configuration Error</h1>
        <p>Please set the following environment variables in <code>.env.local</code>:</p>
        <ul>
          <li><code>VITE_STELLAR_SECRET</code> — Your Stellar secret key (S...)</li>
          <li><code>VITE_FACTORY_ADDRESS</code> — The DripFactory contract ID (C...)</li>
        </ul>
        <p>
          To generate a testnet keypair:
          <br />
          <code>node -e "console.log(require('@stellar/stellar-sdk').Keypair.random().secret())"</code>
        </p>
        <p>
          Then fund it with Friendbot:
          <br />
          <code>curl "https://friendbot.stellar.org?addr=YOUR_G_ADDRESS"</code>
        </p>
      </div>
    );
  }

  // Create a wallet adapter from the secret key.
  const keypair = Keypair.fromSecret(secret);
  const walletAdapter = new KeypairWalletAdapter(keypair);

  return (
    <StreamFiProvider
      network="testnet"
      walletAdapter={walletAdapter}
      factoryAddress={factoryAddress}
    >
      <div className="app-container">
        <header className="app-header">
          <h1>Conduit Stream Dashboard</h1>
          <p>Account: <code>{keypair.publicKey()}</code></p>
        </header>

        <main className="app-main">
          <div className="content-grid">
            <section className="panel">
              <div className="panel-header">
                <h2>Your Streams</h2>
                <button
                  className="btn btn-primary"
                  onClick={() => setShowCreateForm(!showCreateForm)}
                >
                  {showCreateForm ? 'Cancel' : 'Create Stream'}
                </button>
              </div>
              {showCreateForm ? (
                <CreateStreamForm onSuccess={() => setShowCreateForm(false)} />
              ) : (
                <StreamList />
              )}
            </section>
          </div>
        </main>

        <footer className="app-footer">
          <p>
            Running on <strong>testnet</strong> |
            {' '}<a href="https://stellar.org" target="_blank" rel="noopener noreferrer">Stellar</a> {' '}
            | <a href="https://github.com/conduit-protocol/conduit-sdk" target="_blank" rel="noopener noreferrer">SDK</a>
          </p>
        </footer>
      </div>
    </StreamFiProvider>
  );
}

export default App;
