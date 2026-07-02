"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConduitError = exports.ErrorCode = void 0;
var ErrorCode;
(function (ErrorCode) {
    ErrorCode[ErrorCode["NotAuthorized"] = 1] = "NotAuthorized";
    ErrorCode[ErrorCode["StreamNotFound"] = 2] = "StreamNotFound";
    ErrorCode[ErrorCode["StreamCancelled"] = 3] = "StreamCancelled";
    ErrorCode[ErrorCode["StreamNotStarted"] = 4] = "StreamNotStarted";
    ErrorCode[ErrorCode["StreamEnded"] = 5] = "StreamEnded";
    ErrorCode[ErrorCode["NothingToWithdraw"] = 6] = "NothingToWithdraw";
    ErrorCode[ErrorCode["InsufficientDeposit"] = 7] = "InsufficientDeposit";
    ErrorCode[ErrorCode["InvalidTimeRange"] = 8] = "InvalidTimeRange";
    ErrorCode[ErrorCode["AlreadyPaused"] = 9] = "AlreadyPaused";
    ErrorCode[ErrorCode["NotPaused"] = 10] = "NotPaused";
    ErrorCode[ErrorCode["ClawbackDisabled"] = 11] = "ClawbackDisabled";
    ErrorCode[ErrorCode["ArithmeticOverflow"] = 12] = "ArithmeticOverflow";
})(ErrorCode || (exports.ErrorCode = ErrorCode = {}));
const MESSAGES = {
    [ErrorCode.NotAuthorized]: 'Caller is not the sender or recipient of this stream.',
    [ErrorCode.StreamNotFound]: 'Stream not found.',
    [ErrorCode.StreamCancelled]: 'This stream has been cancelled.',
    [ErrorCode.StreamNotStarted]: 'Stream has not started yet.',
    [ErrorCode.StreamEnded]: 'Stream has passed its end time.',
    [ErrorCode.NothingToWithdraw]: 'Nothing to withdraw — balance is zero.',
    [ErrorCode.InsufficientDeposit]: 'Deposit is too small for the requested stream duration.',
    [ErrorCode.InvalidTimeRange]: 'end_time must be greater than start_time.',
    [ErrorCode.AlreadyPaused]: 'Stream is already paused.',
    [ErrorCode.NotPaused]: 'Stream is not currently paused.',
    [ErrorCode.ClawbackDisabled]: 'Clawback was not enabled when this stream was created.',
    [ErrorCode.ArithmeticOverflow]: 'Integer overflow in stream calculation.',
};
class ConduitError extends Error {
    code;
    constructor(code, detail) {
        super(detail ?? MESSAGES[code] ?? `ConduitError(${code})`);
        this.name = 'ConduitError';
        this.code = code;
    }
    static fromContractError(raw) {
        // Contract errors surface as { code: number } in soroban-sdk responses
        if (raw && typeof raw === 'object' && 'code' in raw) {
            const code = Number(raw.code);
            if (code in ErrorCode) {
                return new ConduitError(code);
            }
        }
        return new ConduitError(ErrorCode.StreamNotFound, String(raw));
    }
}
exports.ConduitError = ConduitError;
