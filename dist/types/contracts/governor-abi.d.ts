/**
 * DripGovernor contract spec / ABI.
 *
 * Generate from WASM with:
 *   stellar contract inspect --wasm drip_governor.wasm --output json
 */
export declare const DRIP_GOVERNOR_METHODS: readonly ["initialize", "config", "set_fee_bps", "set_fee_recipient", "set_min_duration", "set_max_rate", "transfer_authority"];
export type DripGovernorMethod = typeof DRIP_GOVERNOR_METHODS[number];
export declare const DRIP_GOVERNOR_SPEC: {
    readonly initialize: {
        readonly args: readonly ["address", "address", "address"];
        readonly returns: "void";
    };
    readonly config: {
        readonly args: readonly [];
        readonly returns: "GovernorConfig";
        readonly readonly: true;
    };
    readonly set_fee_bps: {
        readonly args: readonly ["u32"];
        readonly returns: "void";
        readonly auth: "authority";
    };
    readonly set_fee_recipient: {
        readonly args: readonly ["address"];
        readonly returns: "void";
        readonly auth: "authority";
    };
    readonly set_min_duration: {
        readonly args: readonly ["u64"];
        readonly returns: "void";
        readonly auth: "authority";
    };
    readonly set_max_rate: {
        readonly args: readonly ["i128"];
        readonly returns: "void";
        readonly auth: "authority";
    };
    readonly transfer_authority: {
        readonly args: readonly ["address"];
        readonly returns: "void";
        readonly auth: "authority";
    };
};
