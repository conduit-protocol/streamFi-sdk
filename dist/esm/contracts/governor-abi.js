"use strict";
/**
 * DripGovernor contract spec / ABI.
 *
 * Generate from WASM with:
 *   stellar contract inspect --wasm drip_governor.wasm --output json
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DRIP_GOVERNOR_SPEC = exports.DRIP_GOVERNOR_METHODS = void 0;
exports.DRIP_GOVERNOR_METHODS = [
    'initialize',
    'config',
    'set_fee_bps',
    'set_fee_recipient',
    'set_min_duration',
    'set_max_rate',
    'transfer_authority',
];
exports.DRIP_GOVERNOR_SPEC = {
    initialize: {
        args: ['address', 'address', 'address'], // authority, fee_recipient, factory_address
        returns: 'void',
    },
    config: {
        args: [],
        returns: 'GovernorConfig',
        readonly: true,
    },
    set_fee_bps: {
        args: ['u32'],
        returns: 'void',
        auth: 'authority',
    },
    set_fee_recipient: {
        args: ['address'],
        returns: 'void',
        auth: 'authority',
    },
    set_min_duration: {
        args: ['u64'],
        returns: 'void',
        auth: 'authority',
    },
    set_max_rate: {
        args: ['i128'],
        returns: 'void',
        auth: 'authority',
    },
    transfer_authority: {
        args: ['address'],
        returns: 'void',
        auth: 'authority',
    },
};
