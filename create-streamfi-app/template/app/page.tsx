'use client';

import { useCallback, useEffect, useState } from 'react';
import { listStreams, createStream, withdrawStream } from '../lib/streams';
import { fromStroops, streamProgress } from '@conduit-protocol/sdk';
import type { StreamInfo, CreateStreamResult } from '@conduit-protocol/sdk';

export default function Home() {
  const [address, setAddress] = useState(process.env.NEXT_PUBLIC_ADDRESS ?? '');
  const [streams, setStreams] = useState<StreamInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [recipient, setRecipient] = useState('');
  const [token, setToken] = useState('native');
  const [depositAmount, setDepositAmount] = useState('');
  const [durationDays, setDurationDays] = useState('30');
  const [creating, setCreating] = useState(false);
  const [createResult, setCreateResult] = useState<CreateStreamResult | null>(null);

  const fetchStreams = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setError(null);
    try {
      const res = await listStreams(address);
      setStreams(res.streams);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load streams');
    } finally {
      setLoading(false);
    }
  }, [address]);

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    setCreateResult(null);
    try {
      const result = await createStream({
        recipient,
        token,
        depositAmount,
        durationSeconds: parseInt(durationDays, 10) * 86400,
      });
      setCreateResult(result);
      setCreateOpen(false);
      setRecipient('');
      setDepositAmount('');
      fetchStreams();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create stream');
    } finally {
      setCreating(false);
    }
  };

  const handleWithdraw = async (streamId: bigint) => {
    setError(null);
    try {
      await withdrawStream(streamId);
      fetchStreams();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Withdraw failed');
    }
  };

  const activeStreams = streams.filter(s => !s.cancelled);

  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: '2rem 1rem' }}>
      <h1>StreamFi App</h1>

      <section style={{ marginBottom: '2rem', display: 'flex', gap: '1rem', alignItems: 'flex-end' }}>
        <div>
          <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: 4 }}>
            Stellar Address
          </label>
          <input
            value={address}
            onChange={e => setAddress(e.target.value)}
            placeholder="G..."
            style={{ width: 360, padding: '0.5rem', fontFamily: 'monospace' }}
          />
        </div>
        <button onClick={fetchStreams} disabled={loading || !address}
          style={{ padding: '0.5rem 1rem' }}>
          {loading ? 'Loading...' : 'Fetch Streams'}
        </button>
      </section>

      {error && (
        <p style={{ color: '#d32f2f', background: '#fdecea', padding: '0.75rem', borderRadius: 4 }}>
          {error}
        </p>
      )}

      {createResult && (
        <p style={{ color: '#2e7d32', background: '#e8f5e9', padding: '0.75rem', borderRadius: 4 }}>
          Stream created! ID: {createResult.streamId.toString()}, TX: {createResult.txHash}
        </p>
      )}

      <section style={{ marginBottom: '2rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>Active Streams ({activeStreams.length})</h2>
          <button onClick={() => setCreateOpen(true)}
            style={{ padding: '0.5rem 1rem', fontWeight: 600 }}>
            + New Stream
          </button>
        </div>

        {activeStreams.length === 0 && !loading && (
          <p style={{ color: '#666' }}>No active streams found. Enter an address and click Fetch Streams.</p>
        )}

        <div style={{ display: 'grid', gap: '0.75rem', marginTop: '1rem' }}>
          {activeStreams.map(s => {
            const progress = streamProgress(s);
            return (
              <div key={s.id.toString()}
                style={{
                  border: '1px solid #ddd', borderRadius: 8, padding: '1rem',
                  background: '#fafafa',
                }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <strong>#{s.id.toString()}</strong> — {s.recipient.slice(0, 6)}...{s.recipient.slice(-4)}
                  </div>
                  <span style={{
                    padding: '2px 8px', borderRadius: 4, fontSize: '0.75rem', fontWeight: 600,
                    background: s.paused ? '#fff3e0' : '#e8f5e9',
                    color: s.paused ? '#e65100' : '#2e7d32',
                  }}>
                    {s.paused ? 'PAUSED' : 'ACTIVE'}
                  </span>
                </div>
                <div style={{ marginTop: '0.5rem', fontSize: '0.875rem', color: '#555' }}>
                  Token: {s.token} | Rate: {fromStroops(s.ratePerSecond)}/s |
                  Progress: {isNaN(progress) ? 'N/A' : `${(progress * 100).toFixed(1)}%`}
                </div>
                <button onClick={() => handleWithdraw(s.id)}
                  style={{ marginTop: '0.5rem', padding: '0.25rem 0.75rem', fontSize: '0.8rem' }}>
                  Withdraw
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {createOpen && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
        }}>
          <div style={{ background: '#fff', padding: '2rem', borderRadius: 8, width: 400, maxWidth: '90vw' }}>
            <h2 style={{ marginTop: 0 }}>Create Stream</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: 4 }}>Recipient</label>
                <input value={recipient} onChange={e => setRecipient(e.target.value)}
                  placeholder="G..." style={{ width: '100%', padding: '0.5rem', fontFamily: 'monospace' }} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: 4 }}>Token</label>
                <select value={token} onChange={e => setToken(e.target.value)}
                  style={{ width: '100%', padding: '0.5rem' }}>
                  <option value="native">XLM (native)</option>
                  <option value="USDC">USDC</option>
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: 4 }}>Deposit Amount</label>
                <input value={depositAmount} onChange={e => setDepositAmount(e.target.value)}
                  placeholder="1000" type="number" style={{ width: '100%', padding: '0.5rem' }} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: 4 }}>Duration (days)</label>
                <input value={durationDays} onChange={e => setDurationDays(e.target.value)}
                  type="number" style={{ width: '100%', padding: '0.5rem' }} />
              </div>
            </div>
            <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button onClick={() => setCreateOpen(false)}
                style={{ padding: '0.5rem 1rem' }}>Cancel</button>
              <button onClick={handleCreate} disabled={creating || !recipient || !depositAmount}
                style={{ padding: '0.5rem 1rem', fontWeight: 600 }}>
                {creating ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
