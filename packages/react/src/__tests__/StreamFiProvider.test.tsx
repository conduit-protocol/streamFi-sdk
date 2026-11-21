import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StreamFiProvider, useStreamFiClient } from '../index.js';

function TestChild() {
  const { isReady } = useStreamFiClient();
  return <div data-testid="ready">{isReady ? 'ready' : 'not-ready'}</div>;
}

function renderWithProvider(config?: Parameters<typeof StreamFiProvider>[0]['config']) {
  return render(
    <StreamFiProvider config={config}>
      <TestChild />
    </StreamFiProvider>,
  );
}

describe('StreamFiProvider', () => {
  it('renders children without config', () => {
    renderWithProvider();
    expect(screen.getByTestId('ready')).toHaveTextContent('not-ready');
  });

  it('throws when useStreamFiClient is used outside provider', () => {
    expect(() => render(<TestChild />)).toThrow(
      'useStreamFiClient must be used within a <StreamFiProvider>',
    );
  });
});
