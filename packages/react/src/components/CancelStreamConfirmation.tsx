import type { CancelSettlement } from '../hooks/useCancelStream.js';

export interface CancelStreamConfirmationProps {
  open: boolean;
  settlement: CancelSettlement | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Small unstyled confirmation dialog for irreversible stream cancellation. */
export function CancelStreamConfirmation({
  open,
  settlement,
  onConfirm,
  onCancel,
}: CancelStreamConfirmationProps) {
  if (!open) return null;

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="cancel-stream-title">
      <h2 id="cancel-stream-title">Cancel stream?</h2>
      <p>This action is irreversible and settles the stream immediately.</p>
      <dl>
        <dt>Sender refund</dt>
        <dd>{settlement?.senderRefund ?? 'Calculating…'}</dd>
        <dt>Recipient payout</dt>
        <dd>{settlement?.recipientPayout ?? 'Calculating…'}</dd>
      </dl>
      <button type="button" onClick={onCancel}>Keep stream</button>
      <button type="button" onClick={onConfirm} disabled={!settlement}>Confirm cancellation</button>
    </div>
  );
}
