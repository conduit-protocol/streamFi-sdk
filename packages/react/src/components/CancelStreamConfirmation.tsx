import type { CancelSettlement } from '../hooks/useCancelStream.js';

export interface CancelStreamConfirmationProps {
  open: boolean;
  settlement: CancelSettlement | null;
  onConfirm: () => void;
  onCancel: () => void;
  /** When true the confirm button shows a loading state (e.g. TX in flight). */
  isPending?: boolean;
}

/**
 * Unstyled, accessible confirmation dialog for irreversible stream cancellation.
 * Renders nothing when `open` is false so it can be mounted unconditionally.
 * Export as both `CancelStreamConfirmation` and `CancelStreamConfirmationModal`
 * (#945) so consuming apps can use whichever name fits their conventions.
 */
export function CancelStreamConfirmation({
  open,
  settlement,
  onConfirm,
  onCancel,
  isPending = false,
}: CancelStreamConfirmationProps) {
  if (!open) return null;

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="cancel-stream-title" aria-describedby="cancel-stream-desc">
      <h2 id="cancel-stream-title">Cancel stream?</h2>
      <p id="cancel-stream-desc">This action is irreversible and settles the stream immediately.</p>
      <dl>
        <dt>Sender refund</dt>
        <dd>{settlement?.senderRefund ?? 'Calculating…'}</dd>
        <dt>Recipient payout</dt>
        <dd>{settlement?.recipientPayout ?? 'Calculating…'}</dd>
      </dl>
      <button type="button" onClick={onCancel} disabled={isPending}>Keep stream</button>
      <button type="button" onClick={onConfirm} disabled={!settlement || isPending} aria-busy={isPending}>
        {isPending ? 'Cancelling…' : 'Confirm cancellation'}
      </button>
    </div>
  );
}

/** Alias exported for apps that prefer a `*Modal` naming convention (#945). */
export const CancelStreamConfirmationModal = CancelStreamConfirmation;
