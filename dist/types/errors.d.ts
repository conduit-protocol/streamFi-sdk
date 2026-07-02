export declare enum ErrorCode {
    NotAuthorized = 1,
    StreamNotFound = 2,
    StreamCancelled = 3,
    StreamNotStarted = 4,
    StreamEnded = 5,
    NothingToWithdraw = 6,
    InsufficientDeposit = 7,
    InvalidTimeRange = 8,
    AlreadyPaused = 9,
    NotPaused = 10,
    ClawbackDisabled = 11,
    ArithmeticOverflow = 12
}
export declare class ConduitError extends Error {
    readonly code: ErrorCode;
    constructor(code: ErrorCode, detail?: string);
    static fromContractError(raw: unknown): ConduitError;
}
