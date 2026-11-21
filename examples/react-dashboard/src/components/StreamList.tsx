import { useStreamList } from '@streamfi/react';
import { fromStroops } from '@conduit-protocol/sdk';
import StreamCard from './StreamCard';
import './StreamList.css';

/**
 * Displays all streams for the current account using the useStreamList hook.
 */
export default function StreamList() {
  const { streams, loading, error, refetch } = useStreamList();

  if (error) {
    return (
      <div className="error-box">
        <p><strong>Error loading streams:</strong></p>
        <p>{error.message}</p>
        <button onClick={refetch} className="btn btn-secondary">
          Retry
        </button>
      </div>
    );
  }

  if (loading) {
    return <div className="loading">Loading streams...</div>;
  }

  if (!streams || streams.length === 0) {
    return (
      <div className="empty-state">
        <p>No streams found. Create one to get started!</p>
      </div>
    );
  }

  return (
    <div className="stream-list">
      <div className="stream-count">
        {streams.length} stream{streams.length !== 1 ? 's' : ''}
      </div>
      <div className="stream-grid">
        {streams.map((stream) => (
          <StreamCard key={stream.id} stream={stream} onUpdate={refetch} />
        ))}
      </div>
    </div>
  );
}
