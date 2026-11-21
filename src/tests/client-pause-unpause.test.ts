/**
 * ConduitClient.pauseStream()/unpauseStream() are thin convenience wrappers
 * around client.streams.pause()/resume() — StreamsModule's own pause/resume
 * are covered in streams-success.test.ts, but nothing exercised the
 * ConduitClient-level methods themselves.
 */

import { describe, it, expect, vi } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { ConduitClient } from '../client.js';

function makeClient(): ConduitClient {
  return new ConduitClient({
    network: 'testnet',
    keypair: Keypair.random(),
    factoryAddress: 'CDRIPFACTORY1234567890123456789012345678901234567890123',
  });
}

describe('ConduitClient.pauseStream()', () => {
  it('delegates to client.streams.pause() with the given streamId', async () => {
    const client = makeClient();
    const pauseSpy = vi.spyOn(client.streams, 'pause').mockResolvedValue('tx-hash-pause');

    const result = await client.pauseStream('42');

    expect(pauseSpy).toHaveBeenCalledWith('42');
    expect(result).toBe('tx-hash-pause');
  });

  it('propagates a rejection from client.streams.pause()', async () => {
    const client = makeClient();
    vi.spyOn(client.streams, 'pause').mockRejectedValue(new Error('pause failed'));

    await expect(client.pauseStream('42')).rejects.toThrow('pause failed');
  });
});

describe('ConduitClient.unpauseStream()', () => {
  it('delegates to client.streams.resume() with the given streamId', async () => {
    const client = makeClient();
    const resumeSpy = vi.spyOn(client.streams, 'resume').mockResolvedValue('tx-hash-resume');

    const result = await client.unpauseStream('42');

    expect(resumeSpy).toHaveBeenCalledWith('42');
    expect(result).toBe('tx-hash-resume');
  });

  it('propagates a rejection from client.streams.resume()', async () => {
    const client = makeClient();
    vi.spyOn(client.streams, 'resume').mockRejectedValue(new Error('resume failed'));

    await expect(client.unpauseStream('42')).rejects.toThrow('resume failed');
  });
});
