import { bigintSafeStringify } from './utils.js';

/** Fluent builder for constructing stream configurations. */
export class StreamBuilder {
  private _token?: string;
  private _sender?: string;
  private _recipient?: string;
  private _amount?: number;
  private _ratePerSecond?: number | bigint;

  /**
   * Sets the token contract address for the stream.
   * @param address - The Soroban token contract address.
   * @returns The builder instance for chaining.
   */
  token(address: string): this {
    this._token = StreamBuilder._validateAddress(address, 'token');
    return this;
  }

  /**
   * Sets the sender address for the stream.
   * @param address - The address that will send tokens.
   * @returns The builder instance for chaining.
   */
  sender(address: string): this {
    this._sender = StreamBuilder._validateAddress(address, 'sender');
    return this;
  }

  /**
   * Sets the recipient address for the stream.
   * @param address - The address that will receive tokens.
   * @returns The builder instance for chaining.
   */
  recipient(address: string): this {
    this._recipient = StreamBuilder._validateAddress(address, 'recipient');
    return this;
  }

  /**
   * Sets the amount of tokens to stream.
   * @param val - The amount in the token's smallest unit.
   * @returns The builder instance for chaining.
   */
  amount(val: number): this {
    if (!Number.isFinite(val) || val <= 0) {
      throw new Error('Invalid StreamBuilder parameter: amount must be a positive finite number');
    }
    this._amount = val;
    return this;
  }

  /**
   * Sets the rate of tokens per second (in stroops).
   * Accepts a number or bigint; bigint values are serialised to
   * strings before network submission to avoid Safari/WebKit
   * JSON.stringify quirks.
   * @param val - The rate per second in stroops.
   * @returns The builder instance for chaining.
   */
  ratePerSecond(val: number | bigint): this {
    if (typeof val === 'bigint') {
      if (val <= 0n) {
        throw new Error('Invalid StreamBuilder parameter: ratePerSecond must be a positive value');
      }
    } else {
      if (!Number.isFinite(val) || val <= 0) {
        throw new Error('Invalid StreamBuilder parameter: ratePerSecond must be a positive finite number');
      }
    }
    this._ratePerSecond = val;
    return this;
  }

  /**
   * Validates and produces the final stream configuration.
   * Any bigint fields are converted to strings to guarantee safe
   * serialisation across all browsers (Safari/WebKit included).
   * @returns An object containing `token`, `sender`, `recipient`, `amount`, and optionally `ratePerSecond`.
   * @throws {Error} If any required field (`token`, `sender`, `recipient`, `amount`) is missing or malformed.
   */
  build() {
    if (this._token === undefined || this._sender === undefined || this._recipient === undefined || this._amount === undefined) {
      throw new Error("Missing required parameters for StreamBuilder");
    }
    const config: Record<string, unknown> = {
      token: this._token,
      sender: this._sender,
      recipient: this._recipient,
      amount: this._amount,
    };
    if (this._ratePerSecond !== undefined) {
      config.ratePerSecond = this._ratePerSecond;
    }
    return bigintSafeStringify(config) as {
      token: string;
      sender: string;
      recipient: string;
      amount: number;
      ratePerSecond?: string;
    };
  }

  private static _validateAddress(address: string, field: string): string {
    if (typeof address !== 'string' || address.trim().length === 0) {
      throw new Error(`Invalid StreamBuilder parameter: ${field} must be a non-empty string`);
    }
    return address;
  }
}

export class ConduitBatcher {
  /**
   * Bundle multiple stream operations into a single transaction.
   *
   * Any `bigint` fields inside the stream objects are converted to
   * strings before further processing so that downstream
   * `JSON.stringify` calls produce valid payloads on Safari / WebKit
   * browsers (which serialise bigint as `{}` instead of throwing).
   */
  static execute(streams: Record<string, unknown>[]) {
    const sanitized = streams.map(bigintSafeStringify);
    console.log(`Bundling ${sanitized.length} stream operations into a single transaction...`);
    // Mock Soroban XDR assembly
    return {
      success: true,
      operations: sanitized.length,
      xdr: "AAAA...mock...batch...XDR",
    };
  }
}
