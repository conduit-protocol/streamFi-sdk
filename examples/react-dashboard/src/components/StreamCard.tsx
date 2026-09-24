import { useState } from 'react';
import { useWithdrawStream, useStream } from '@streamfi/react';
import { fromStroops } from '@conduit-protocol/sdk';
import type { StreamInfo } from '@conduit-protocol/sdk';
import './StreamCard.css';

interface StreamCardProps {
  stream: StreamInfo;
  onUpdate?: () => void;
}

/**
 * Displays details of a single stream with withdraw and other action buttons.
 * Uses useWithdrawStream and useStream hooks.
 */
export default function StreamCard({ stream, onUpdate }: StreamCardProps) {
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState('');

  const { data: streamData, loading: dataLoading } = useStream(stream.id);
  const { withdraw, loading: withdrawLoading, error: withdrawError } = useWithdrawStream();

  const handleWithdraw = async () => {
    if (!withdrawAmount || !streamData?.withdrawable) return;

    try {
      await withdraw({
        streamId: stream.id,
        amount: BigInt(withdrawAmount),
      });
      setWithdrawAmount('');
      setShowWithdraw(false);
      onUpdate?.();
    } catch (err) {
      console.error('Withdrawal error:', err);
    }
  };

  const withdrawable = streamData?.withdrawable ?? 0n;
  const withdrawableXLM = fromStroops(withdrawable);

  const now = Math.floor(Date.now() / 1000);
  const isActive = stream.startTime <= now && now < stream.endTime;
  const isPaused = stream.paused;
  const isCancelled = stream.cancelled;

  let statusBadge = 'active';
  if (isCancelled) statusBadge = 'cancelled';
  else if (isPaused) statusBadge = 'paused';
  else if (now < stream.startTime) statusBadge = 'pending';
  else if (now >= stream.endTime) statusBadge = 'ended';

  return (
    <div className={`stream-card stream-card--${statusBadge}`}>
      <div className="stream-card-header">
        <div>
          <h3>Stream #{stream.id.toString()}</h3>
          <span className={`badge badge--${statusBadge}`}>{statusBadge}</span>
        </div>
      </div>

      <div className="stream-card-details">
        <div className="detail-row">
          <span className="label">Recipient:</span>
          <span className="value mono">{stream.recipient.slice(0, 10)}...</span>
        </div>

        <div className="detail-row">
          <span className="label">Token:</span>
          <span className="value">{stream.token.name || stream.token.address.slice(0, 10)}</span>
        </div>

        <div className="detail-row">
          <span className="label">Deposited:</span>
          <span className="value">{fromStroops(stream.depositAmount)} {stream.token.code}</span>
        </div>

        {dataLoading ? (
          <div className="detail-row">
            <span className="label">Withdrawable:</span>
            <span className="value">Loading...</span>
          </div>
        ) : (
          <div className="detail-row">
            <span className="label">Withdrawable:</span>
            <span className="value highlight">{withdrawableXLM} {stream.token.code}</span>
          </div>
        )}

        <div className="detail-row">
          <span className="label">Sender:</span>
          <span className="value mono">{stream.sender.slice(0, 10)}...</span>
        </div>

        <div className="detail-row">
          <span className="label">Start:</span>
          <span className="value">{new Date(stream.startTime * 1000).toLocaleDateString()}</span>
        </div>

        <div className="detail-row">
          <span className="label">End:</span>
          <span className="value">{new Date(stream.endTime * 1000).toLocaleDateString()}</span>
        </div>
      </div>

      <div className="stream-card-actions">
        {withdrawable > 0n && !isCancelled && (
          <>
            <button
              className="btn btn-small btn-primary"
              onClick={() => setShowWithdraw(!showWithdraw)}
            >
              {showWithdraw ? 'Cancel' : 'Withdraw'}
            </button>

            {showWithdraw && (
              <div className="withdraw-form">
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max={withdrawableXLM}
                  value={withdrawAmount}
                  onChange={(e) => setWithdrawAmount(e.target.value)}
                  placeholder={`Max: ${withdrawableXLM}`}
                  disabled={withdrawLoading}
                  className="input-field"
                />
                <button
                  className="btn btn-small btn-success"
                  onClick={handleWithdraw}
                  disabled={!withdrawAmount || withdrawLoading}
                >
                  {withdrawLoading ? 'Processing...' : 'Confirm'}
                </button>
                {withdrawError && (
                  <p className="error-text">{withdrawError.message}</p>
                )}
              </div>
            )}
          </>
        )}

        {withdrawable === 0n && (
          <p className="text-muted">Nothing to withdraw yet</p>
        )}
      </div>
    </div>
  );
}
