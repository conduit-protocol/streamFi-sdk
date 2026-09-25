import React, { createContext, useContext } from 'react';
import type { ConduitClient } from '../client.js';

export const ConduitContext = createContext<ConduitClient | null>(null);

export interface ConduitProviderProps {
  client: ConduitClient;
  children: React.ReactNode;
}

export function ConduitProvider({ client, children }: ConduitProviderProps): React.JSX.Element {
  return React.createElement(ConduitContext.Provider, { value: client }, children);
}

export function useConduitClient(customClient?: ConduitClient): ConduitClient {
  const contextClient = useContext(ConduitContext);
  const client = customClient ?? contextClient;

  if (!client) {
    throw new Error(
      'ConduitClient not found. Wrap your component in <ConduitProvider client={client}> or pass client option.',
    );
  }

  return client;
}
