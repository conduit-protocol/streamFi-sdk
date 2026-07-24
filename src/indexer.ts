export interface GraphQLQueryOptions {
  query: string;
  variables?: Record<string, unknown>;
}

export interface GraphQLSubscriptionOptions {
  query: string;
  variables?: Record<string, unknown>;
  onData: (data: unknown) => void;
  onError?: (error: Error) => void;
}

export interface IndexerSubscription {
  unsubscribe: () => void;
}

export class GraphQLIndexer {
  private endpoint: string;
  private activeSubscriptions: Set<IndexerSubscription> = new Set();
  private isDestroyed = false;

  constructor(endpoint: string) {
    if (!endpoint || typeof endpoint !== 'string' || endpoint.trim().length === 0) {
      throw new Error('GraphQLIndexer endpoint must be a non-empty string');
    }
    this.endpoint = endpoint;
  }

  async query(options: GraphQLQueryOptions): Promise<unknown> {
    if (this.isDestroyed) {
      throw new Error('GraphQLIndexer has been destroyed');
    }
    if (!options || typeof options !== 'object') {
      throw new Error('GraphQLQueryOptions cannot be null or undefined');
    }
    if (!options.query || typeof options.query !== 'string' || options.query.trim().length === 0) {
      throw new Error('GraphQL query string cannot be null or empty');
    }

    // Boundary check on variables
    const variables = options.variables ?? {};
    if (typeof variables !== 'object' || variables === null) {
      throw new Error('GraphQL query variables must be an object');
    }

    const payload = { query: options.query, variables };

    // Simulate async RPC/GraphQL fetch
    return Promise.resolve({
      data: {
        indexed: true,
        endpoint: this.endpoint,
        payload,
      },
    });
  }

  subscribe(options: GraphQLSubscriptionOptions): IndexerSubscription {
    if (this.isDestroyed) {
      throw new Error('GraphQLIndexer has been destroyed');
    }
    if (!options || typeof options !== 'object') {
      throw new Error('GraphQLSubscriptionOptions cannot be null or undefined');
    }
    if (!options.query || typeof options.query !== 'string' || options.query.trim().length === 0) {
      throw new Error('GraphQL subscription query string cannot be null or empty');
    }
    if (typeof options.onData !== 'function') {
      throw new Error('GraphQL subscription onData callback must be a function');
    }

    let unsubscribed = false;
    let timer: NodeJS.Timeout | null = null;

    const subscription: IndexerSubscription = {
      unsubscribe: () => {
        if (unsubscribed) return;
        unsubscribed = true;
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        this.activeSubscriptions.delete(subscription);
      },
    };

    this.activeSubscriptions.add(subscription);

    // Periodic subscription event callback with lifecycle boundary check
    timer = setInterval(() => {
      if (unsubscribed || this.isDestroyed) {
        subscription.unsubscribe();
        return;
      }

      try {
        options.onData({ timestamp: Date.now(), status: 'STREAM_UPDATED' });
      } catch (err) {
        if (options.onError && typeof options.onError === 'function') {
          options.onError(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }, 1000);

    return subscription;
  }

  getSubscriptionCount(): number {
    return this.activeSubscriptions.size;
  }

  cleanup(): void {
    this.isDestroyed = true;
    for (const sub of Array.from(this.activeSubscriptions)) {
      sub.unsubscribe();
    }
    this.activeSubscriptions.clear();
  }
}
