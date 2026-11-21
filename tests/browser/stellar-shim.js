// Minimal shim of @stellar/stellar-sdk for browser compatibility testing.
// Only provides the exports that the Conduit SDK actually imports.

class StrKey {
  static isValidEd25519PublicKey(addr) {
    return typeof addr === 'string' && addr.length === 56 && addr.startsWith('G');
  }
  static isValidContract(addr) {
    return typeof addr === 'string' && addr.length === 56 && addr.startsWith('C');
  }
}

class Keypair {
  static fromSecret(secret) {
    return { publicKey: () => 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF' };
  }
}

class Account {
  constructor(accountId, sequence) {
    this.accountId = () => accountId;
    this._sequence = sequence;
  }
  sequenceNumber() {
    return this._sequence;
  }
  incrementSequenceNumber() {
    this._sequence = (BigInt(this._sequence) + 1n).toString();
  }
}

class Address {
  constructor(addr) { this.addr = addr; }
  toScVal() { return {}; }
  static fromScVal() { return { toString: () => '' }; }
}

const SorobanRpc = {
  Server: class {
    constructor() {}
    simulateTransaction() { return {}; }
    sendTransaction() { return {}; }
    getTransaction() { return {}; }
  },
  Api: {
    isSimulationError() { return false; },
    GetTransactionStatus: { SUCCESS: 'SUCCESS', FAILED: 'FAILED' },
  },
  assembleTransaction() { return { build: () => ({ sign: () => {}, toXDR: () => '' }) }; },
};

function nativeToScVal() { return {}; }
function boolToScVal() { return {}; }

const xdr = {
  ScVal: { fromXDR: () => ({ map: () => [], sym: () => null, str: () => null, b: () => false }) },
};

const Networks = { PUBLIC: 'public', TESTNET: 'testnet' };

class Contract {
  constructor(address) { this.address = address; }
}

class TransactionBuilder {
  static fromXDR() { return {}; }
}

const BASE_FEE = '100';

class Asset {
  constructor(code, issuer) {
    this.code = code;
    this.issuer = issuer;
  }
  static native() {
    return new Asset('XLM');
  }
  contractId(_networkPassphrase) {
    return 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
  }
}

class Transaction {
  constructor(xdr, passphrase) {
    this.xdr = xdr;
    this.passphrase = passphrase;
  }
  sign() {}
  toXDR() { return ''; }
}

export {
  StrKey,
  Keypair,
  Account,
  Address,
  Asset,
  SorobanRpc,
  nativeToScVal,
  boolToScVal,
  xdr,
  Transaction,
  Networks,
  Contract,
  TransactionBuilder,
  BASE_FEE,
};
