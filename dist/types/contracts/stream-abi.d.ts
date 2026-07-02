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
export declare const DRIP_STREAM_METHODS: readonly ["initialize", "withdraw", "cancel", "pause", "resume", "top_up", "clawback", "withdrawable", "info"];
export type DripStreamMethod = typeof DRIP_STREAM_METHODS[number];
/**
 * Minimal type description for each method.
 * Used by the SDK for argument encoding hints.
 */
export declare const DRIP_STREAM_SPEC: {
    readonly initialize: {
        readonly args: readonly ["address", "address", "address", "i128", "u64", "u64", "bool"];
        readonly returns: "void";
    };
    readonly withdraw: {
        readonly args: readonly ["i128"];
        readonly returns: "i128";
        readonly auth: "recipient";
    };
    readonly cancel: {
        readonly args: readonly [];
        readonly returns: "void";
        readonly auth: "sender";
    };
    readonly pause: {
        readonly args: readonly [];
        readonly returns: "void";
        readonly auth: "sender";
    };
    readonly resume: {
        readonly args: readonly [];
        readonly returns: "void";
        readonly auth: "sender";
    };
    readonly top_up: {
        readonly args: readonly ["i128"];
        readonly returns: "void";
        readonly auth: "sender";
    };
    readonly clawback: {
        readonly args: readonly [];
        readonly returns: "i128";
        readonly auth: "sender";
    };
    readonly withdrawable: {
        readonly args: readonly [];
        readonly returns: "i128";
        readonly readonly: true;
    };
    readonly info: {
        readonly args: readonly [];
        readonly returns: "StreamInfo";
        readonly readonly: true;
    };
};
