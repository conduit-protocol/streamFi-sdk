"use strict";
/**
 * DripStream contract spec / ABI.
 *
 * These are the Soroban contract spec entries for DripStream, expressed as
 * TypeScript constants. They are used by the SDK to build and decode
 * contract invocations without depending on the generated WASM spec at
 * runtime.
 *
 * In production, generate this file from the compiled WASM using:
 *   stellar contract inspect --wasm drip_stream.wasm --output json
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DRIP_STREAM_SPEC = exports.DRIP_STREAM_METHODS = void 0;
exports.DRIP_STREAM_METHODS = [
    'initialize',
    'withdraw',
    'cancel',
    'pause',
    'resume',
    'top_up',
    'clawback',
    'withdrawable',
    'info',
];
/**
 * Minimal type description for each method.
 * Used by the SDK for argument encoding hints.
 */
exports.DRIP_STREAM_SPEC = {
    initialize: {
        args: ['address', 'address', 'address', 'i128', 'u64', 'u64', 'bool'],
        returns: 'void',
    },
    withdraw: {
        args: ['i128'],
        returns: 'i128',
        auth: 'recipient',
    },
    cancel: {
        args: [],
        returns: 'void',
        auth: 'sender',
    },
    pause: {
        args: [],
        returns: 'void',
        auth: 'sender',
    },
    resume: {
        args: [],
        returns: 'void',
        auth: 'sender',
    },
    top_up: {
        args: ['i128'],
        returns: 'void',
        auth: 'sender',
    },
    clawback: {
        args: [],
        returns: 'i128',
        auth: 'sender',
    },
    withdrawable: {
        args: [],
        returns: 'i128',
        readonly: true,
    },
    info: {
        args: [],
        returns: 'StreamInfo',
        readonly: true,
    },
};
