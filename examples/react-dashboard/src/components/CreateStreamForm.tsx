import { useState } from 'react';
import { useCreateStream } from '@streamfi/react';
import { MIN_STREAM_DURATION_SECONDS } from '@conduit-protocol/sdk';
import './CreateStreamForm.css';

interface CreateStreamFormProps {
  onSuccess?: () => void;
}

/**
 * Form to create a new stream using the useCreateStream hook.
 */
export default function CreateStreamForm({ onSuccess }: CreateStreamFormProps) {
  const { createStream, loading, error } = useCreateStream();

  const [formData, setFormData] = useState({
    recipient: '',
    token: 'native',
    depositAmount: '',
    durationDays: '30',
    clawbackEnabled: false,
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? (e.target as HTMLInputElement).checked : value,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const durationSeconds = parseInt(formData.durationDays) * 86400;
    if (durationSeconds < MIN_STREAM_DURATION_SECONDS) {
      alert(
        `Duration must be at least ${Math.ceil(MIN_STREAM_DURATION_SECONDS / 3600)} hours`
      );
      return;
    }

    if (!formData.recipient.startsWith('G')) {
      alert('Recipient must be a valid Stellar address (starting with G)');
      return;
    }

    try {
      await createStream({
        recipient: formData.recipient,
        token: formData.token as 'native' | { address: string; decimals: number; code: string },
        depositAmount: formData.depositAmount,
        durationSeconds,
        clawbackEnabled: formData.clawbackEnabled,
      });

      alert('✅ Stream created successfully!');
      setFormData({
        recipient: '',
        token: 'native',
        depositAmount: '',
        durationDays: '30',
        clawbackEnabled: false,
      });
      onSuccess?.();
    } catch (err) {
      // Error is already in the hook's error state
      console.error('Failed to create stream:', err);
    }
  };

  return (
    <form className="create-stream-form" onSubmit={handleSubmit}>
      <div className="form-group">
        <label htmlFor="recipient">Recipient Address *</label>
        <input
          id="recipient"
          type="text"
          name="recipient"
          value={formData.recipient}
          onChange={handleChange}
          placeholder="G... (Stellar address)"
          disabled={loading}
          className="input-field"
          required
        />
        <small>The account that will receive the stream</small>
      </div>

      <div className="form-group">
        <label htmlFor="token">Token *</label>
        <select
          id="token"
          name="token"
          value={formData.token}
          onChange={handleChange}
          disabled={loading}
          className="input-field"
        >
          <option value="native">XLM (native)</option>
        </select>
      </div>

      <div className="form-group">
        <label htmlFor="depositAmount">Deposit Amount *</label>
        <input
          id="depositAmount"
          type="number"
          name="depositAmount"
          value={formData.depositAmount}
          onChange={handleChange}
          placeholder="100"
          step="0.01"
          min="0"
          disabled={loading}
          className="input-field"
          required
        />
        <small>Total amount to stream (in XLM)</small>
      </div>

      <div className="form-group">
        <label htmlFor="durationDays">Duration (days) *</label>
        <input
          id="durationDays"
          type="number"
          name="durationDays"
          value={formData.durationDays}
          onChange={handleChange}
          placeholder="30"
          min="1"
          disabled={loading}
          className="input-field"
          required
        />
        <small>Stream duration in days (minimum ~1 hour)</small>
      </div>

      <div className="form-group form-group--checkbox">
        <label htmlFor="clawbackEnabled">
          <input
            id="clawbackEnabled"
            type="checkbox"
            name="clawbackEnabled"
            checked={formData.clawbackEnabled}
            onChange={handleChange}
            disabled={loading}
          />
          <span>Enable clawback</span>
        </label>
        <small>Allow cancelling and reclaiming unvested tokens</small>
      </div>

      {error && (
        <div className="error-box">
          <strong>Error:</strong> {error.message}
        </div>
      )}

      <button type="submit" disabled={loading} className="btn btn-primary btn-block">
        {loading ? 'Creating...' : 'Create Stream'}
      </button>
    </form>
  );
}
