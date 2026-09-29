import {
  Address,
  Transaction,
  nativeToScVal,
} from '@stellar/stellar-sdk';
import type { ConduitConfig } from './types/index.js';
import type { WalletAdapter } from './adapters/types.js';
import type { Signer } from './signer.js';
import { KeypairWalletAdapter } from './adapters/keypair.js';
import {
  buildContractCallTx,
  DEFAULT_RPC,
  invokeContract,
  NETWORK_PASSPHRASE,
  resolveFee,
  scValToI128,
  simulateReadOnly,
} from './soroban.js';

/** SEP-41 token allowance queries and approvals. */
export class TokenModule {
  private readonly rpcUrl: string;
  private readonly passphrase: string;
  private readonly fee: string;
  private activeWallet?: WalletAdapter;

  constructor(private readonly config: ConduitConfig) {
    this.rpcUrl = config.rpcUrl ?? DEFAULT_RPC[config.network];
    this.passphrase = NETWORK_PASSPHRASE[config.network];
    this.fee = resolveFee(config);

    if (config.wallet) {
      this.activeWallet = config.wallet;
    } else if (config.keypair) {
      this.activeWallet = new KeypairWalletAdapter(config.keypair);
    }
  }

  /** Replace the wallet used to sign future token approvals. */
  setWallet(wallet: WalletAdapter): void {
    this.activeWallet = wallet;
  }

  /** Read the amount `spenderAddress` may transfer from `ownerAddress`. */
  async allowance(
    tokenAddress: string,
    ownerAddress: string,
    spenderAddress: string,
    signal?: AbortSignal,
  ): Promise<bigint> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const tx = await buildContractCallTx(
      this.rpcUrl,
      this.passphrase,
      ownerAddress,
      tokenAddress,
      'allowance',
      [new Address(ownerAddress).toScVal(), new Address(spenderAddress).toScVal()],
      this.fee,
    );
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const value = await simulateReadOnly(this.rpcUrl, this.passphrase, tx);
    return scValToI128(value);
  }

  /**
   * Set the SEP-41 allowance for `spenderAddress`.
   *
   * `expirationLedger` is the last ledger on which the allowance remains
   * valid. Pass `0` only when setting `amount` to `0` to revoke an allowance.
   */
  async approve(
    tokenAddress: string,
    ownerAddress: string,
    spenderAddress: string,
    amount: bigint,
    expirationLedger: number,
  ): Promise<string> {
    if (amount < 0n) throw new RangeError('amount must be greater than or equal to 0');
    if (!Number.isInteger(expirationLedger) || expirationLedger < 0 || expirationLedger > 0xFFFFFFFF) {
      throw new RangeError('expirationLedger must be a u32 integer');
    }

    const signer = await this.signerFor(ownerAddress);
    const tx = await buildContractCallTx(
      this.rpcUrl,
      this.passphrase,
      ownerAddress,
      tokenAddress,
      'approve',
      [
        new Address(ownerAddress).toScVal(),
        new Address(spenderAddress).toScVal(),
        nativeToScVal(amount, { type: 'i128' }),
        nativeToScVal(expirationLedger, { type: 'u32' }),
      ],
      this.fee,
    );
    return invokeContract(this.rpcUrl, this.passphrase, signer, tx);
  }

  private async signerFor(ownerAddress: string): Promise<Signer> {
    if (this.activeWallet) {
      const wallet = this.activeWallet;
      const signingAddress = await wallet.getPublicKey();
      if (signingAddress !== ownerAddress) {
        throw new Error(
          `Token allowance owner ${ownerAddress} does not match the connected wallet ${signingAddress}`,
        );
      }
      return {
        publicKey: () => signingAddress,
        sign: async (tx: Transaction): Promise<Transaction> => {
          const signed = await wallet.signTransaction(tx, {
            networkPassphrase: this.passphrase,
            accountToSign: signingAddress,
          });
          if (signed == null) {
            throw new Error('Wallet adapter signTransaction returned null or undefined');
          }
          return typeof signed === 'string'
            ? new Transaction(signed, this.passphrase)
            : signed;
        },
      };
    }

    if (this.config.signer) {
      const signingAddress = this.config.signer.publicKey();
      if (signingAddress !== ownerAddress) {
        throw new Error(
          `Token allowance owner ${ownerAddress} does not match the configured signer ${signingAddress}`,
        );
      }
      return this.config.signer;
    }

    throw new Error('keypair, wallet adapter, or signer is required to approve a token allowance');
  }
}
