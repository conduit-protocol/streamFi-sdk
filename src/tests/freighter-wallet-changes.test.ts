import { describe, it, expect, vi, afterEach } from 'vitest';
import { Networks } from '@stellar/stellar-sdk';
import { FreighterWalletAdapter, type FreighterApi } from '../adapters/freighter.js';

const KEY_A = 'GAAZI4TCR3TY5OJHCTJC2A4QSYRZPB26WKP43SXUXZVTYTBAKW7N5B6X';
const KEY_B = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

/** A Freighter stub whose active address and network the test controls. */
function makeFreighter(initial: { address: string; network?: string }) {
  const state = { address: initial.address, error: undefined as string | undefined, network: initial.network ?? Networks.TESTNET };
  const client: FreighterApi = {
    getAddress: vi.fn(async () => (state.error ? { error: state.error } : { address: state.address })),
    getNetworkDetails: vi.fn(async () => ({ networkPassphrase: state.network })),
  };
  return { client, state };
}

describe('FreighterWalletAdapter wallet change detection (#1078)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('updates the cached key and notifies when the user switches accounts', async () => {
    const { client, state } = makeFreighter({ address: KEY_A });
    const onWalletChange = vi.fn();
    const adapter = new FreighterWalletAdapter({ freighter: client, publicKey: KEY_A, onWalletChange });

    state.address = KEY_B;
    await adapter.syncWalletState();

    expect(await adapter.getPublicKey()).toBe(KEY_B);
    expect(onWalletChange).toHaveBeenCalledWith({ type: 'accountChanged', publicKey: KEY_B });
  });

  it('clears the cached key when Freighter is locked, and announces the unlock', async () => {
    const { client, state } = makeFreighter({ address: KEY_A });
    const changes: string[] = [];
    const adapter = new FreighterWalletAdapter({ freighter: client, publicKey: KEY_A });
    adapter.onWalletChange((change) => changes.push(`${change.type}:${change.publicKey}`));

    state.error = 'locked';
    await adapter.syncWalletState();
    expect(adapter.isConnected()).toBe(false);

    state.error = undefined;
    await adapter.syncWalletState();
    expect(adapter.isConnected()).toBe(true);
    expect(changes).toEqual(['locked:null', `accountChanged:${KEY_A}`]);
  });

  it('notifies on a network switch', async () => {
    const { client, state } = makeFreighter({ address: KEY_A });
    const onWalletChange = vi.fn();
    const adapter = new FreighterWalletAdapter({ freighter: client, publicKey: KEY_A, onWalletChange });

    await adapter.syncWalletState(); // records the starting network
    state.network = Networks.PUBLIC;
    await adapter.syncWalletState();

    expect(onWalletChange).toHaveBeenCalledWith({
      type: 'networkChanged',
      publicKey: KEY_A,
      networkPassphrase: Networks.PUBLIC,
    });
  });

  it('does not report a change when nothing changed', async () => {
    const { client } = makeFreighter({ address: KEY_A });
    const onWalletChange = vi.fn();
    const adapter = new FreighterWalletAdapter({ freighter: client, publicKey: KEY_A, onWalletChange });
    await adapter.syncWalletState();
    await adapter.syncWalletState();
    expect(onWalletChange).not.toHaveBeenCalled();
  });

  it('polls on an interval and stops on the returned function and on disconnect()', async () => {
    vi.useFakeTimers();
    const { client, state } = makeFreighter({ address: KEY_A });
    const onWalletChange = vi.fn();
    const adapter = new FreighterWalletAdapter({ freighter: client, publicKey: KEY_A, onWalletChange });

    const stop = adapter.watchWalletChanges(1000);
    state.address = KEY_B;
    await vi.advanceTimersByTimeAsync(1000);
    expect(onWalletChange).toHaveBeenCalledTimes(1);

    stop();
    const callsAfterStop = (client.getAddress as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect((client.getAddress as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterStop);

    adapter.watchWalletChanges(1000);
    await adapter.disconnect();
    await vi.advanceTimersByTimeAsync(5000);
    expect((client.getAddress as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterStop);
  });
});
