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

function TestPromptSwitcher({ onResult }: { onResult?: (res: any) => void }) {
  const { network, promptSwitchNetwork } = useNetworkSwitcher();

  return (
    <div>
      <div data-testid="prompt-network">{network ?? 'none'}</div>
      <button
        data-testid="prompt-switch-mainnet"
        onClick={async () => {
          try {
            const res = await promptSwitchNetwork('mainnet');
            onResult?.({ success: res });
          } catch (err: any) {
            onResult?.({ error: err });
          }
        }}
      >
        Prompt Switch Mainnet
      </button>
      <button
        data-testid="prompt-switch-invalid"
        onClick={async () => {
          try {
            const res = await promptSwitchNetwork('invalid-chain');
            onResult?.({ success: res });
          } catch (err: any) {
            onResult?.({ error: err });
          }
        }}
      >
        Prompt Switch Invalid
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

  it('prompts network switch and calls wallet rpc if available', async () => {
    const mockSwitch = vi.fn().mockResolvedValue(true);
    (window as any).freighter = {
      switchNetwork: mockSwitch,
    };

    const handleResult = vi.fn();
    render(
      <StreamFiProvider config={{ network: 'testnet' }}>
        <TestPromptSwitcher onResult={handleResult} />
      </StreamFiProvider>,
    );

    expect(screen.getByTestId('prompt-network')).toHaveTextContent('testnet');

    await act(async () => {
      screen.getByTestId('prompt-switch-mainnet').click();
    });

    expect(mockSwitch).toHaveBeenCalledWith('mainnet');
    expect(screen.getByTestId('prompt-network')).toHaveTextContent('mainnet');
    expect(handleResult).toHaveBeenCalledWith({ success: true });

    delete (window as any).freighter;
  });

  it('rejects promptSwitchNetwork with unsupported network', async () => {
    const handleResult = vi.fn();
    render(
      <StreamFiProvider config={{ network: 'testnet' }}>
        <TestPromptSwitcher onResult={handleResult} />
      </StreamFiProvider>,
    );

    await act(async () => {
      screen.getByTestId('prompt-switch-invalid').click();
    });

    expect(handleResult).toHaveBeenCalled();
    const result = handleResult.mock.calls[0][0];
    expect(result.error).toBeDefined();
  });
});
