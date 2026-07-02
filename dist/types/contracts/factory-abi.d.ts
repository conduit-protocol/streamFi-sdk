/**
 * DripFactory contract spec / ABI.
 *
 * Generate from WASM with:
 *   stellar contract inspect --wasm drip_factory.wasm --output json
 */
export declare const DRIP_FACTORY_METHODS: readonly ["initialize", "create_stream", "stream_address", "streams_by_sender", "streams_by_recipient", "stream_count", "protocol_fee_bps"];
export type DripFactoryMethod = typeof DRIP_FACTORY_METHODS[number];
export declare const DRIP_FACTORY_SPEC: {
    readonly initialize: {
        readonly args: readonly ["bytes32", "address"];
        readonly returns: "void";
    };
    readonly create_stream: {
        readonly args: readonly ["address", "address", "address", "i128", "i128", "u64", "u64", "bool"];
        readonly returns: "u64";
        readonly auth: "sender";
    };
    readonly stream_address: {
        readonly args: readonly ["u64"];
        readonly returns: "option<address>";
        readonly readonly: true;
    };
    readonly streams_by_sender: {
        readonly args: readonly ["address", "u32", "u32"];
        readonly returns: "vec<u64>";
        readonly readonly: true;
    };
    readonly streams_by_recipient: {
        readonly args: readonly ["address", "u32", "u32"];
        readonly returns: "vec<u64>";
        readonly readonly: true;
    };
    readonly stream_count: {
        readonly args: readonly [];
        readonly returns: "u64";
        readonly readonly: true;
    };
    readonly protocol_fee_bps: {
        readonly args: readonly [];
        readonly returns: "u32";
        readonly readonly: true;
    };
};
