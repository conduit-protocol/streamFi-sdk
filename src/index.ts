export { ConduitClient } from './client.js';
export { StreamBuilder, ConduitBatcher } from './builder.js';
export type {
  BatchOperation,
  BatchExecuteOptions,
  BatchExecuteAsyncOptions,
  BatchResult,
} from './builder.js';
export {
  buildBatchTransactions,
  buildBatchTransactionsSync,
  BatchBuildError,
} from './batch-tx.js';
export type {
  BatchTransactionContext,
  BuiltBatchTransaction,
} from './batch-tx.js';
export { GraphQLIndexer } from './indexer.js';
export { KeypairSigner } from './signer.js';
export type { Signer } from './signer.js';
export {
  ConduitError,
  StreamErrorCode,
  FactoryErrorCode,
  GovernorErrorCode,
  UnsupportedChainError,
  StreamFiNetworkError,
  InsufficientBalanceError,
  RateLimitError,
  SUPPORTED_NETWORKS,
  UNKNOWN_CONTRACT_ERROR_CODE,
} from './errors.js';
export type { ConduitContract } from './errors.js';
export * from './types/index.js';
export * from './adapters/index.js';
export { FeeEstimator } from './fee-estimator.js';
export type { FeeEstimateOptions } from './fee-estimator.js';
export { WebSocketRelayer } from './relayer/WebSocketRelayer.js';
export { ErrorMapper } from './relayer/ErrorMapper.js';
export type { MappedErrorHandler } from './relayer/ErrorMapper.js';

// Utils are exported via the /utils subpath export, but also available here
export {
  toStroops,
  fromStroops,
  calculateRate,
  calculateYield,
  streamProgress,
  withdrawableLocal,
  bigintSafeStringify,
} from './utils.js';

// RPC server lifecycle
export { getServer, clearServerCache } from './soroban.js';
export { getTokenDecimals, clearTokenDecimalsCache } from './soroban.js';

export {
  formatAddress,
  formatAmount,
  formatTimestamp,
} from './dashboard/transaction-history.js';

export { Module36 } from './module36.js';
export type {
  Module36Config,
  StreamSnapshot,
  StreamDiff,
  Module36Metrics,
} from './module36.js';

export { Module26 } from './module26.js';
export type {
  Module26Config,
  PortfolioStreamItem,
  PortfolioSummary,
  Module26Metrics,
} from './module26.js';

export { Module48 } from './module48.js';
export type {
  Module48Config,
  StreamBatchItem,
  Module48Result,
  Module48Metrics,
} from './module48.js';

export { Module49 } from './module49.js';
export type {
  Module49Config,
  StreamBatchItem49,
  Module49Result,
  Module49Metrics,
} from './module49.js';

