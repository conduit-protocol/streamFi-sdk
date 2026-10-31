export { ConduitClient } from "./client.js";
export {
  StreamsModule,
  validateStreamParameters,
  calculateVestedPercentage,
  isStreamCancellableByAccount,
  simulateWithdraw,
} from "./streams.js";
export type {
  SimulatedWithdraw,
  SimulateWithdrawOptions,
} from "./streams.js";
export { StreamBuilder, ConduitBatcher } from "./builder.js";
export type { SimulateOptions, SimulationResult } from "./builder.js";
export type {
  BatchOperation,
  BatchExecuteOptions,
  BatchExecuteAsyncOptions,
  BatchChunkProgress,
  BatchResult,
} from "./builder.js";
export { withRetry, isTransientRpcError } from "./with-retry.js";
export type { WithRetryOptions } from "./with-retry.js";
export {
  buildBatchTransactions,
  buildBatchTransactionsSync,
  preBatchSimulate,
  simulateBatch,
  BatchBuildError,
  BatchPartiallySubmittedError,
  submitBatch,
} from "./batch-tx.js";
export type {
  BatchTransactionContext,
  BuiltBatchTransaction,
  ScValType,
  BatchSubmitResult,
  BatchSubmitOutcome,
  BatchTxOutcome,
  BatchTxStatus,
  BatchSubmitOptions,
  BatchSimulationResult,
  BuildableOperation,
  BatchPayload,
  BatchSimulationSummary,
} from "./batch-tx.js";
export {
  GraphQLIndexer,
  DEFAULT_INDEXER_TIMEOUT_MS,
  DEFAULT_INDEXER_MAX_PAGES,
  LedgerGapDetector,
} from "./indexer.js";
export {
  MockGraphQLIndexer,
  createMockIndexer,
  createMockEventStream,
  createMockEventStreamPage,
  DEFAULT_MOCK_EVENT_LIFECYCLE,
} from "./mock-indexer.js";
export type {
  MockQueryMap,
  MockSubscriptionMap,
  MockIndexerOptions,
  MockStreamEventKind,
  MockEventStreamOptions,
} from "./mock-indexer.js";
export type {
  GraphQLQueryOptions,
  GraphQLSubscriptionOptions,
  IndexerSubscription,
  IndexerConfig,
  IndexerQueryMetric,
  IndexerPage,
  IndexerPageInfo,
  FetchStreamsBySenderOptions,
} from "./indexer.js";
export {
  withSignatureTimeout,
  DEFAULT_SIGNATURE_TIMEOUT_MS,
  KeypairSigner,
  LedgerSigner,
  LedgerErrorType,
  LedgerHardwareError,
  normalizeLedgerError,
  classifyLedgerError,
  WebAuthnSigner,
  derToRawSignature,
} from "./signer.js";
export type {
  Signer,
  SignerOptions,
  WebAuthnCredentialDescriptor,
  WebAuthnAssertionResponse,
  WebAuthnAssertionCredential,
  WebAuthnCredentialsContainer,
  WebAuthnCredentialScValKeys,
  WebAuthnSignerOptions,
} from "./signer.js";
export {
  SorobanRpcError,
  ConduitError,
  StreamErrorCode,
  FactoryErrorCode,
  GovernorErrorCode,
  UnsupportedChainError,
  StreamFiNetworkError,
  InsufficientBalanceError,
  RateLimitError,
  RpcServiceUnavailableError,
  IndexerTimeoutError,
  OperationAbortedError,
  StreamNotFoundError,
  AmountExceedsWithdrawableError,
  UnauthorizedStreamActionError,
  InvalidStreamStateError,
  ClawbackNotEnabledError,
  RateExceedsMaxError,
  DurationTooShortError,
  GovernorInvalidParamError,
  BackdatedStreamError,
  ConfirmationTimeoutError,
  SignatureTimeoutError,
  UserCancelledError,
  AlbedoCancelError,
  NetworkMismatchError,
  WalletTimeoutError,
  AlbedoInvalidSignatureError,
  isRecoverableError,
  IndexerMaxPagesExceededError,
  isConduitError,
  SUPPORTED_NETWORKS,
  CAIP2_TO_NETWORK,
  UNKNOWN_CONTRACT_ERROR_CODE,
  parseContractError,
  ContractError,
  mapHorizonError,
  BadAuthError,
  HorizonTransactionError,
} from "./errors.js";
export type {
  ConduitContract,
  StreamLifecycleState,
  SorobanDiagnosticInfo,
  ContractErrorContext,
  ContractErrorDiagnostic,
  HorizonResultCodes,
} from "./errors.js";
export * from "./types/index.js";
export type {
  BatchGetStreamsOptions,
  GetStreamInfosOptions,
  GetStreamInfosResult,
  GetStreamInfosFailure,
} from "./types/index.js";
export * from "./adapters/index.js";
export * from "./react/index.js";
export {
  FeeEstimator,
  estimateBatchFootprint,
  DEFAULT_CPU_INSTRUCTION_LIMIT,
  DEFAULT_INSTRUCTIONS_PER_BATCH_ITEM,
  DEFAULT_BATCH_FIXED_OVERHEAD_INSTRUCTIONS,
  DEFAULT_BATCH_WARN_THRESHOLD,
} from "./fee-estimator.js";
export type {
  FeeEstimatorOptions,
  FeeEstimateOptions,
  FeePriority,
  DynamicFeeOptions,
  BatchFootprintOptions,
  ResourceEstimate,
} from "./fee-estimator.js";
export { coalesceAsync, coalesceInFlight } from "./coalesce-async.js";
export { WebSocketRelayer } from "./relayer/WebSocketRelayer.js";
export {
  ErrorMapper,
  DEFAULT_ERROR_MESSAGE_TYPE_MAP,
  extractDiagnosticMessage,
} from "./relayer/ErrorMapper.js";
export type {
  MappedErrorHandler,
  ErrorMessageTypeMap,
} from "./relayer/ErrorMapper.js";

// Utils are exported via the /utils subpath export, but also available here
export {
  toStroops,
  fromStroops,
  calculateRate,
  calculateYield,
  streamProgress,
  remainingTime,
  estimatedCompletionDate,
  normalizeProgress,
  withdrawableLocal,
  sumWithdrawable,
  streamedTotalLocal,
  sumStreamedTotal,
  bigintSafeStringify,
  timeoutSignal,
  streamStatus,
  formatDuration,
  parseDuration,
  validateAndNormalizeAddress,
  isValidAddress,
  formatTokenAmount,
} from "./utils.js";

// Constants
export {
  MIN_STREAM_DURATION_SECONDS,
  NETWORK_NAMES,
  EXPLORER_URLS,
  NETWORK_CONFIG,
  CONTRACT_IDS,
  getContractId,
} from "./constants.js";
export type {
  NetworkType,
  RpcNetworkId,
  RpcNetworkConfig,
  ContractRole,
} from "./constants.js";

export { TokenModule } from "./token.js";

// RPC server lifecycle
export { getServer, clearServerCache, resolveFee } from "./soroban.js";
export {
  DEFAULT_HORIZON,
  getAccountWithFallback,
} from "./soroban.js";
export type { BuildContractCallTxOptions } from "./soroban.js";
export { waitForConfirmation } from "./soroban.js";
export type {
  WaitForConfirmationOptions,
  ConfirmedTransaction,
} from "./soroban.js";
export {
  getTokenDecimals,
  clearTokenDecimalsCache,
  getTokenDecimalsCacheMetrics,
  resetTokenDecimalsCacheMetrics,
} from "./soroban.js";
export { getLatestLedgerInfo, clearLedgerInfoCache } from "./soroban.js";
export type { LedgerInfo } from "./soroban.js";
export {
  getCircuitState,
  recordSuccess,
  recordFailure,
  resetCircuit,
  getAllCircuitStates,
  onCircuitChange,
  onCircuitStateChange,
  subscribeCircuitTransitions,
  type CircuitTransitionListener,
  type CircuitState,
  type CircuitStatus,
} from "./rpc-circuit-state.js";

export {
  formatAddress,
  formatAmount,
  formatTimestamp,
  exportTransactionsToCsv,
  exportTransactionsToJson,
  type ExportTransactionsOptions,
} from "./dashboard/transaction-history.js";

export { Module36 } from "./module36.js";
export type {
  Module36Config,
  StreamSnapshot,
  StreamDiff,
  Module36Metrics,
} from "./module36.js";
/** Descriptive alias for {@link Module36} (#777). */
export { Module36 as StreamSnapshotDiffer } from "./module36.js";

export { Module26 } from "./module26.js";
export type {
  Module26Config,
  PortfolioStreamItem,
  PortfolioSummary,
  Module26Metrics,
} from "./module26.js";
/** Descriptive alias for {@link Module26} (#777). */
export { Module26 as PortfolioAggregator } from "./module26.js";

export { Module48 } from "./module48.js";
export type {
  Module48Config,
  StreamBatchItem,
  Module48Result,
  Module48Metrics,
} from "./module48.js";
/** Descriptive alias for {@link Module48} (#777). */
export { Module48 as StreamBatchProcessor } from "./module48.js";

export { Module49 } from "./module49.js";
export type {
  Module49Config,
  StreamBatchItem49,
  Module49Result,
  Module49Metrics,
} from "./module49.js";
/** Descriptive alias for {@link Module49} (#777). */
export { Module49 as StreamAnalyticsEngine } from "./module49.js";

export { Module44 } from "./module44.js";
export type {
  Module44Config,
  StreamRiskItem,
  LiquidityRiskLevel,
  StreamRiskAssessment,
  Module44Metrics,
} from "./module44.js";
/** Descriptive alias for {@link Module44} (#777). */
export { Module44 as StreamRiskAssessor } from "./module44.js";

export { FactoryModule } from "./factory.js";
export type {
  FactoryStreamListResult,
  StreamAddressesOptions,
  PaginatedStreamIdsResult,
} from "./factory.js";
export {
  GovernorModule,
  ProposalState,
  parseProposalState,
  formatProposalState,
} from "./governor.js";
export type {
  StreamHistoryEntry,
  StreamHistoryPage,
  StreamHistoryOptions,
  CliffReachedListenerOptions,
  ReplayEventsOptions,
  ReplayEventsResult,
} from "./events.js";
export type {
  GovernorProposal,
  ExecuteProposalResult,
  ExecuteProposalsOptions,
} from "./governor.js";
