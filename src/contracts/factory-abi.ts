/**
 * DripFactory contract spec / ABI.
 *
 * Generate from WASM with:
 *   stellar contract inspect --wasm drip_factory.wasm --output json
 */

export const DRIP_FACTORY_METHODS = [
  'initialize',
  'create_stream',
  'stream_address',
  'streams_by_sender',
  'streams_by_recipient',
  'stream_count',
  'protocol_fee_bps',
] as const;

export type DripFactoryMethod = typeof DRIP_FACTORY_METHODS[number];

export const DRIP_FACTORY_SPEC = {
  initialize: {
    args: ['bytes32', 'address'], // wasm_hash, governor
    returns: 'void',
  },
  create_stream: {
    args: ['address', 'address', 'address', 'i128', 'i128', 'u64', 'u64', 'bool'],
    // sender, recipient, token, deposit, rate_per_sec, start_time, end_time, clawback
    returns: 'u64',        // stream_id
    auth: 'sender',
  },
  stream_address: {
    args: ['u64'],          // stream_id
    returns: 'option<address>',
    readonly: true,
  },
  streams_by_sender: {
    args: ['address', 'u32', 'u32'], // sender, offset, limit
    returns: 'vec<u64>',
    readonly: true,
  },
  streams_by_recipient: {
    args: ['address', 'u32', 'u32'],
    returns: 'vec<u64>',
    readonly: true,
  },
  stream_count: {
    args: [],
    returns: 'u64',
    readonly: true,
  },
  protocol_fee_bps: {
    args: [],
    returns: 'u32',
    readonly: true,
  },
} as const;
