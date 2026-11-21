/**
 * In-memory mock transport for {@link GraphQLIndexer}.
 *
 * Lets consumers unit-test indexer-backed code without stubbing the global
 * `fetch` or running a real GraphQL server. Query results and subscription
 * events are injected up-front and returned deterministically.
 *
 * @example
 * ```ts
 * const indexer = createMockIndexer({
 *   'query GetStreams { streams { id } }': { streams: [{ id: '1' }] },
 * });
 *
 * const result = await indexer.query({ query: 'query GetStreams { streams { id } }' });
 * // result === { streams: [{ id: '1' }] }
 * ```
 */

import type {
  GraphQLQueryOptions,
  GraphQLSubscriptionOptions,
  IndexerSubscription,
} from "./indexer.js";
import type { StreamHistoryEntry, StreamHistoryPage } from "./events.js";
import type {
  CreatedEvent,
  WithdrawEvent,
  StreamTopUpEvent,
  PauseEvent,
  ResumeEvent,
  CancelEvent,
  StreamClawbackedEvent,
} from "./types/index.js";

/** Preset response map: query string → resolved data. */
export type MockQueryMap = Record<string, unknown>;

/** Preset subscription event map: query string → array of events to emit. */
export type MockSubscriptionMap = Record<string, unknown[]>;

export interface MockIndexerOptions {
  /** Pre-baked responses for `query()` calls. */
  queries?: MockQueryMap;
  /** Pre-baked event arrays for `subscribe()` calls. */
  subscriptions?: MockSubscriptionMap;
  /** When true, unknown queries throw instead of returning undefined. Default false. */
  strict?: boolean;
  /**
   * Artificial delay (ms) applied to every `query()` resolution and every
   * `subscribe()` emission, simulating network latency (#911). Default 0.
   */
  latencyMs?: number;
  /**
   * Probability in `[0, 1)` that any given call/emission fails, simulating
   * intermittent RPC connection drops so clients can exercise their
   * error-handling UI (#911). Default 0. Failures throw from `query()` and
   * surface through `subscribe()`'s `onError`.
   */
  failureRate?: number;
  /**
   * Source of randomness, defaults to `Math.random`. Inject a deterministic
   * generator in tests to assert failure behaviour reproducibly.
   */
  random?: () => number;
}

/**
 * A drop-in replacement for {@link GraphQLIndexer} that serves injected
 * responses from memory. Useful in unit tests and offline demos.
 */
export class MockGraphQLIndexer {
  private readonly queries: MockQueryMap;
  private readonly subscriptions: MockSubscriptionMap;
  private readonly strict: boolean;
  private readonly latencyMs: number;
  private readonly failureRate: number;
  private readonly random: () => number;
  private _destroyed = false;

  constructor(options: MockIndexerOptions = {}) {
    this.queries = options.queries ?? {};
    this.subscriptions = options.subscriptions ?? {};
    this.strict = options.strict ?? false;
    this.latencyMs = options.latencyMs ?? 0;
    this.failureRate = options.failureRate ?? 0;
    this.random = options.random ?? Math.random;
  }

  private async delay(): Promise<void> {
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }
  }

  /** True when the next operation should be simulated as a dropped connection. */
  private shouldFail(): boolean {
    return this.failureRate > 0 && this.random() < this.failureRate;
  }

  async query(options: GraphQLQueryOptions): Promise<unknown> {
    if (this._destroyed) {
      throw new Error("MockGraphQLIndexer has been destroyed");
    }
    await this.delay();
    if (this.shouldFail()) {
      throw new Error("MockGraphQLIndexer: simulated RPC connection drop");
    }
    const q = options.query.trim();
    if (q in this.queries) {
      return this.queries[q];
    }
    if (this.strict) {
      throw new Error(
        `MockGraphQLIndexer: no preset response for query "${q}"`,
      );
    }
    return undefined;
  }

  subscribe(options: GraphQLSubscriptionOptions): IndexerSubscription {
    if (this._destroyed) {
      throw new Error("MockGraphQLIndexer has been destroyed");
    }
    const q = options.query.trim();
    const events = this.subscriptions[q] ?? [];

    let unsubscribed = false;
    // Emit events on next tick so the caller can attach listeners first,
    // applying the configured latency and dropping some at random (#911).
    const timers = events.map((evt, i) =>
      setTimeout(() => {
        if (unsubscribed || this._destroyed) return;
        if (this.shouldFail()) {
          options.onError?.(new Error("MockGraphQLIndexer: simulated RPC connection drop"));
          return;
        }
        options.onData(evt);
      }, (i * 10) + this.latencyMs),
    );

    return {
      unsubscribe: () => {
        if (unsubscribed) return;
        unsubscribed = true;
        for (const timer of timers) {
          clearTimeout(timer);
        }
      },
    };
  }

  getSubscriptionCount(): number {
    return 0;
  }

  cleanup(): void {
    this._destroyed = true;
  }
}

/**
 * Convenience factory for {@link MockGraphQLIndexer}.
 *
 * @example
 * ```ts
 * const indexer = createMockIndexer({
 *   queries: {
 *     'query { streams }': { streams: [] },
 *   },
 * });
 * ```
 */
export function createMockIndexer(
  options?: MockIndexerOptions,
): MockGraphQLIndexer {
  return new MockGraphQLIndexer(options);
}

// ── Deterministic event generator (#965) ─────────────────────────────────────
//
// Testing SDK consumers (event handlers, history/dashboard UIs) against a
// real Soroban testnet sandbox is slow and non-deterministic. This generates
// a sequenced, reproducible run of stream lifecycle events shaped exactly
// like `StreamHistoryEntry` — the same shape `getStreamHistory()` returns —
// so consumer code can be exercised without any RPC/indexer at all.

/** Lifecycle event kinds {@link createMockEventStream} can generate. */
export type MockStreamEventKind = StreamHistoryEntry["kind"];

/** The default lifecycle generated when `kinds` is omitted. */
export const DEFAULT_MOCK_EVENT_LIFECYCLE: readonly MockStreamEventKind[] = [
  "created",
  "top_up",
  "withdraw",
  "pause",
  "resume",
  "withdraw",
  "cancel",
];

export interface MockEventStreamOptions {
  /** Sender address used for sender-originated events (`created`, `top_up`, `pause`, `resume`, `cancel`, `clawback`). */
  sender?: string;
  /** Recipient address used for recipient-originated events (`created`, `withdraw`). */
  recipient?: string;
  /** Token address used by the `created` event. Default `'native'`. */
  token?: string;
  /** Deposit amount in stroops used by the `created` event. Default `1_000_000_000n`. */
  depositAmount?: bigint;
  /** Streaming rate in stroops/second used by the `created` event. Default `1_000n`. */
  ratePerSecond?: bigint;
  /** Ledger sequence of the first generated event. Default `1_000_000`. */
  startLedger?: number;
  /** Unix ms timestamp of the first generated event. Default `1_700_000_000_000`. */
  startTimestamp?: number;
  /**
   * Lifecycle event kinds to generate, in order. Defaults to
   * {@link DEFAULT_MOCK_EVENT_LIFECYCLE} — a full
   * create → top-up → withdraw → pause → resume → withdraw → cancel run.
   */
  kinds?: MockStreamEventKind[];
}

const MOCK_SENDER = `G${"S".repeat(55)}`;
const MOCK_RECIPIENT = `G${"R".repeat(55)}`;

/** Deterministic, fixed-width hex placeholder for a transaction hash. */
function mockTxHash(index: number): string {
  return (index + 1).toString(16).padStart(64, "0");
}

/**
 * Generates a deterministic, sequenced run of DripStream lifecycle events for
 * unit and integration tests — no Soroban RPC, indexer, or testnet sandbox
 * required.
 *
 * Each entry is shaped exactly like {@link StreamHistoryEntry} (the type
 * `getStreamHistory()` returns), so the output is a drop-in stand-in for
 * real on-chain history — feed it to history/dashboard rendering code, or
 * destructure `.event` to exercise `StreamEventHandlers` callbacks directly.
 * Calling it twice with the same `options` always returns the same result.
 *
 * @example
 * ```ts
 * const entries = createMockEventStream({ depositAmount: 500_000_000n });
 * expect(entries.map((e) => e.kind)).toEqual([
 *   'created', 'top_up', 'withdraw', 'pause', 'resume', 'withdraw', 'cancel',
 * ]);
 * ```
 */
export function createMockEventStream(
  options: MockEventStreamOptions = {},
): StreamHistoryEntry[] {
  const sender = options.sender ?? MOCK_SENDER;
  const recipient = options.recipient ?? MOCK_RECIPIENT;
  const token = options.token ?? "native";
  const depositAmount = options.depositAmount ?? 1_000_000_000n;
  const ratePerSecond = options.ratePerSecond ?? 1_000n;
  const startLedger = options.startLedger ?? 1_000_000;
  const startTimestamp = options.startTimestamp ?? 1_700_000_000_000;
  const kinds = options.kinds ?? DEFAULT_MOCK_EVENT_LIFECYCLE;
  const startTimeSeconds = Math.floor(startTimestamp / 1000);

  let withdrawnTotal = 0n;
  let toppedUpTotal = 0n;
  let withdrawCount = 0;
  let topUpCount = 0;

  return kinds.map((kind, i): StreamHistoryEntry => {
    const ledger = startLedger + i;
    // Soroban RPC closes ledgers roughly every 5s (see DEFAULT_HISTORY_LOOKBACK_LEDGERS
    // in events.ts) — mirror that spacing so timestamps look plausible.
    const timestampMs = startTimestamp + i * 5_000;
    const sequence = BigInt(i + 1);
    const base = {
      id: `${ledger}-0`,
      ledger,
      timestamp: new Date(timestampMs).toISOString(),
      txHash: mockTxHash(i),
    };

    switch (kind) {
      case "created": {
        const event: CreatedEvent = {
          sender,
          recipient,
          token,
          depositAmount,
          ratePerSecond,
          startTime: startTimeSeconds,
          endTime: 0,
          sequence,
        };
        return { ...base, kind, event };
      }
      case "top_up": {
        topUpCount++;
        const amount = 2_000_000n * BigInt(topUpCount);
        toppedUpTotal += amount;
        const event: StreamTopUpEvent = {
          sender,
          amount,
          newBalance: depositAmount + toppedUpTotal - withdrawnTotal,
          sequence,
        };
        return { ...base, kind, event };
      }
      case "withdraw": {
        withdrawCount++;
        const amount = 500_000n * BigInt(withdrawCount);
        withdrawnTotal += amount;
        const event: WithdrawEvent = {
          recipient,
          amount,
          totalWithdrawn: withdrawnTotal,
          remaining: depositAmount + toppedUpTotal - withdrawnTotal,
          sequence,
        };
        return { ...base, kind, event };
      }
      case "pause": {
        const event: PauseEvent = {
          sender,
          pausedAt: startTimeSeconds + i * 5,
          withdrawable: depositAmount + toppedUpTotal - withdrawnTotal,
          sequence,
        };
        return { ...base, kind, event };
      }
      case "resume": {
        const event: ResumeEvent = {
          sender,
          resumedAt: startTimeSeconds + i * 5,
          sequence,
        };
        return { ...base, kind, event };
      }
      case "cancel": {
        const event: CancelEvent = {
          sender,
          refundAmount: depositAmount + toppedUpTotal - withdrawnTotal,
          withdrawnSoFar: withdrawnTotal,
          sequence,
        };
        return { ...base, kind, event };
      }
      case "clawback": {
        const event: StreamClawbackedEvent = {
          sender,
          amount: depositAmount + toppedUpTotal - withdrawnTotal,
          sequence,
        };
        return { ...base, kind, event };
      }
    }
  });
}

/**
 * Convenience wrapper that bundles {@link createMockEventStream}'s output
 * into a {@link StreamHistoryPage} — a drop-in replacement for
 * `getStreamHistory()`'s return value in tests, with `nextCursor` always
 * `undefined` (the mock run never paginates).
 */
export function createMockEventStreamPage(
  options: MockEventStreamOptions = {},
): StreamHistoryPage {
  return { entries: createMockEventStream(options), nextCursor: undefined };
}
