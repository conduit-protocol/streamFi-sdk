import { useContext } from 'react';
import { StreamFiContext } from './StreamFiProvider.js';
import type { StreamFiContextValue } from './StreamFiProvider.js';

export function useStreamFiClient(): StreamFiContextValue {
  const ctx = useContext(StreamFiContext);
  if (!ctx) {
    throw new Error(
      'useStreamFiClient must be used within a <StreamFiProvider>. ' +
      'Wrap your component tree with <StreamFiProvider> to provide a ConduitClient instance.',
    );
  }
  return ctx;
}
