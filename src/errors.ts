export enum ErrorCode {
  NotAuthorized       = 1,
  StreamNotFound      = 2,
  StreamCancelled     = 3,
  StreamNotStarted    = 4,
  StreamEnded         = 5,
  NothingToWithdraw   = 6,
  InsufficientDeposit = 7,
  InvalidTimeRange    = 8,
  AlreadyPaused       = 9,
  NotPaused           = 10,
  ClawbackDisabled    = 11,
  ArithmeticOverflow  = 12,
}

const MESSAGES: Record<ErrorCode, string> = {
  [ErrorCode.NotAuthorized]:       'Caller is not the sender or recipient of this stream.',
  [ErrorCode.StreamNotFound]:      'Stream not found.',
  [ErrorCode.StreamCancelled]:     'This stream has been cancelled.',
  [ErrorCode.StreamNotStarted]:    'Stream has not started yet.',
  [ErrorCode.StreamEnded]:         'Stream has passed its end time.',
  [ErrorCode.NothingToWithdraw]:   'Nothing to withdraw — balance is zero.',
  [ErrorCode.InsufficientDeposit]: 'Deposit is too small for the requested stream duration.',
  [ErrorCode.InvalidTimeRange]:    'end_time must be greater than start_time.',
  [ErrorCode.AlreadyPaused]:       'Stream is already paused.',
  [ErrorCode.NotPaused]:           'Stream is not currently paused.',
  [ErrorCode.ClawbackDisabled]:    'Clawback was not enabled when this stream was created.',
  [ErrorCode.ArithmeticOverflow]:  'Integer overflow in stream calculation.',
};

export class ConduitError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, detail?: string) {
    super(detail ?? MESSAGES[code] ?? `ConduitError(${code})`);
    this.name = 'ConduitError';
    this.code = code;
  }

  static fromContractError(raw: unknown): ConduitError {
    // Contract errors surface as { code: number } in soroban-sdk responses
    if (raw && typeof raw === 'object' && 'code' in raw) {
      const code = Number((raw as { code: unknown }).code);
      if (code in ErrorCode) {
        return new ConduitError(code as ErrorCode);
      }
    }
    return new ConduitError(ErrorCode.StreamNotFound, String(raw));
  }
}
