"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConduitClient = void 0;
const soroban_js_1 = require("./soroban.js");
const streams_js_1 = require("./streams.js");
const factory_js_1 = require("./factory.js");
const governor_js_1 = require("./governor.js");
class ConduitClient {
    streams;
    factory;
    governor;
    config;
    constructor(config) {
        this.config = {
            ...config,
            rpcUrl: config.rpcUrl ?? soroban_js_1.DEFAULT_RPC[config.network],
        };
        this.streams = new streams_js_1.StreamsModule(this.config);
        this.factory = new factory_js_1.FactoryModule(this.config);
        this.governor = new governor_js_1.GovernorModule(this.config);
    }
}
exports.ConduitClient = ConduitClient;
