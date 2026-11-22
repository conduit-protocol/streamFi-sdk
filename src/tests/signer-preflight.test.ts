import { describe, it, expect, vi } from 'vitest';
import { Keypair, Account, Operation, Networks, Asset, TransactionBuilder, SorobanRpc } from '@stellar/stellar-sdk';
import {
  PreflightSimulationError,
  PreflightSigner,
  preflightSimulate,
  withPreflightSimulation,
  type PreflightSimulationServer,
  type Signer,
} from '../signer.js';

function buildTx() {
  const kp = Keypair.random();
  return new TransactionBuilder(new Account(kp.publicKey(), '1'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.payment({ destination: kp.publicKey(), asset: Asset.native(), amount: '1' }))
    .setTimeout(30)
    .build();
}

const OK: SorobanRpc.Api.SimulateTransactionResponse = { result: { retval: {} } } as SorobanRpc.Api.SimulateTransactionResponse;
const REVERT: SorobanRpc.Api.SimulateTransactionResponse = {
  error: 'Error(Contract, #12)',
  diagnostics: [{ message: 'insufficient balance' }],
} as unknown as SorobanRpc.Api.SimulateTransactionResponse;

function serverReturning(response: SorobanRpc.Api.SimulateTransactionResponse) {
  return { simulateTransaction: vi.fn(async () => response) } as unknown as PreflightSimulationServer;
}

describe('pre-flight simulation', () => {
  it('simulates before returning on a successful simulation', async () => {
    const server = serverReturning(OK);
    await expect(preflightSimulate(buildTx(), { server })).resolves.toBe(OK);
    expect(server.simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it('throws a descriptive PreflightSimulationError on a revert', async () => {
    const server = serverReturning(REVERT);
    const error = await preflightSimulate(buildTx(), { server }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PreflightSimulationError);
    const typed = error as PreflightSimulationError;
    expect(typed.message).toContain('Pre-flight simulation failed');
    expect(typed.message).toContain('insufficient balance');
    expect(typed.revertReason).toContain('Error(Contract, #12)');
    expect(typed.diagnostics).toContain('insufficient balance');
  });

  it('skips when unavailable and honours disabled/onUnavailable', async () => {
    await expect(preflightSimulate(buildTx())).resolves.toBeUndefined();
    await expect(preflightSimulate(buildTx(), { onUnavailable: 'throw' }))
      .rejects.toBeInstanceOf(PreflightSimulationError);
    const server = serverReturning(REVERT);
    await expect(preflightSimulate(buildTx(), { server, disabled: true })).resolves.toBeUndefined();
    expect(server.simulateTransaction).not.toHaveBeenCalled();
  });

  it('never invokes the wrapped wallet signer when simulation reverts', async () => {
    const sign = vi.fn(() => undefined);
    const wallet: Signer = { sign, publicKey: () => 'GWALLET' };
    const wrapped = withPreflightSimulation(wallet, { server: serverReturning(REVERT) });

    expect(wrapped.publicKey()).toBe('GWALLET');
    await expect(wrapped.sign(buildTx())).rejects.toBeInstanceOf(PreflightSimulationError);
    expect(sign).not.toHaveBeenCalled();
  });

  it('delegates to the wallet signer after a successful simulation', async () => {
    const tx = buildTx();
    const sign = vi.fn(() => tx);
    const wrapped = new PreflightSigner(
      { sign, publicKey: () => 'GWALLET' },
      { server: serverReturning(OK) },
    );

    expect(await wrapped.sign(tx)).toBe(tx);
    expect(sign).toHaveBeenCalledWith(tx);
  });
});
