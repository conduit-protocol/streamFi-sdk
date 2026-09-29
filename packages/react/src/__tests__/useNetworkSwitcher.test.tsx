import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { StreamFiProvider, useNetworkSwitcher } from '../index.js';

vi.mock('@conduit-protocol/sdk', async () => {
  const actual = await vi.importActual<typeof import('@conduit-protocol/sdk')>('@conduit-protocol/sdk');
  return {
    ...actual,
    ConduitClient: vi.fn(function (config: any) {
      return {
        network: config.network,
        streams: { get: vi.fn() },
      };
    }),
  };
});

function TestSwitcher() {
  const { network, setNetwork, isSupportedNetwork, availableNetworks } = useNetworkSwitcher();

  return (
    <div>
      <div data-testid="network">{network ?? 'none'}</div>
      <div data-testid="available">{availableNetworks.join(',')}</div>
      <div data-testid="is-supported-mainnet">
        {isSupportedNetwork('mainnet') ? 'yes' : 'no'}
      </div>
      <div data-testid="is-supported-invalid">
        {isSupportedNetwork('invalid-network') ? 'yes' : 'no'}
      </div>
      <button data-testid="switch-to-mainnet" onClick={() => setNetwork('mainnet')}>
        Switch to Mainnet
      </button>
      <button data-testid="switch-to-invalid" onClick={() => setNetwork('invalid-network' as any)}>
        Switch to Invalid
      </button>
    </div>
  );
}

describe('useNetworkSwitcher', () => {
  it('throws error when used outside StreamFiProvider', () => {
    expect(() => render(<TestSwitcher />)).toThrow(
      'useNetworkSwitcher must be used within a <StreamFiProvider>',
    );
  });

  it('provides current network, available networks and validates support', () => {
    render(
      <StreamFiProvider config={{ network: 'testnet' }}>
        <TestSwitcher />
      </StreamFiProvider>,
    );

    expect(screen.getByTestId('network')).toHaveTextContent('testnet');
    expect(screen.getByTestId('available')).toHaveTextContent('mainnet,testnet,local');
    expect(screen.getByTestId('is-supported-mainnet')).toHaveTextContent('yes');
    expect(screen.getByTestId('is-supported-invalid')).toHaveTextContent('no');
  });

  it('switches network reactively when setNetwork is called', () => {
    render(
      <StreamFiProvider config={{ network: 'testnet' }}>
        <TestSwitcher />
      </StreamFiProvider>,
    );

    expect(screen.getByTestId('network')).toHaveTextContent('testnet');

    act(() => {
      screen.getByTestId('switch-to-mainnet').click();
    });

    expect(screen.getByTestId('network')).toHaveTextContent('mainnet');
  });
});
