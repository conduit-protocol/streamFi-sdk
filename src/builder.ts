/** Fluent builder for constructing stream configurations. */
export class StreamBuilder {
  private _token?: string;
  private _sender?: string;
  private _recipient?: string;
  private _amount?: number;

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
   * Validates and produces the final stream configuration.
   * @returns An object containing `token`, `sender`, `recipient`, and `amount`.
   * @throws {Error} If any required field (`token`, `sender`, `recipient`, `amount`) is missing or malformed.
   */
  build() {
    if (this._token === undefined || this._sender === undefined || this._recipient === undefined || this._amount === undefined) {
      throw new Error("Missing required parameters for StreamBuilder");
    }
    return {
      token: this._token,
      sender: this._sender,
      recipient: this._recipient,
      amount: this._amount,
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
  static execute(streams: Record<string, unknown>[]) {
    console.log(`Bundling ${streams.length} stream operations into a single transaction...`);
    // Mock Soroban XDR assembly
    return {
      success: true,
      operations: streams.length,
      xdr: "AAAA...mock...batch...XDR",
    };
  }
}
