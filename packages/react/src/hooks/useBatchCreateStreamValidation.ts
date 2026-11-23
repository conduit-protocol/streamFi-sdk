import { useState, useCallback } from 'react';
import { isValidAddress } from '@conduit-protocol/sdk/utils';
import type { StreamConfig } from '@conduit-protocol/sdk';

export interface CsvStreamRow {
  recipient: string;
  amount: string;
  startTime: string;
  endTime: string;
  token?: string;
}

export interface StreamRowValidationError {
  row: number;
  field: keyof CsvStreamRow;
  message: string;
}

export interface UseBatchCreateStreamValidationResult {
  validate: (rows: CsvStreamRow[]) => StreamConfig[];
  errors: StreamRowValidationError[];
  isValid: boolean;
  reset: () => void;
}

function parsePositiveBigInt(value: string): bigint | null {
  try {
    const n = BigInt(value.trim());
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

function parsePositiveInt(value: string): number | null {
  const n = Number(value.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Validates a batch of CSV payroll rows against stream creation rules and
 * converts them to {@link StreamConfig} objects ready to pass to
 * `useCreateBatchStreams`. Call `validate()` before submitting; the hook
 * accumulates all field errors so the UI can highlight every invalid cell
 * in one pass. (#859)
 */
export function useBatchCreateStreamValidation(): UseBatchCreateStreamValidationResult {
  const [errors, setErrors] = useState<StreamRowValidationError[]>([]);

  const reset = useCallback(() => setErrors([]), []);

  const validate = useCallback((rows: CsvStreamRow[]): StreamConfig[] => {
    const errs: StreamRowValidationError[] = [];
    const configs: StreamConfig[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;

      let rowValid = true;

      if (!row.recipient || !isValidAddress(row.recipient)) {
        errs.push({ row: i, field: 'recipient', message: 'Must be a valid Stellar G... or C... address' });
        rowValid = false;
      }

      const amount = parsePositiveBigInt(row.amount);
      if (amount === null) {
        errs.push({ row: i, field: 'amount', message: 'Must be a positive integer (stroops)' });
        rowValid = false;
      }

      const startTime = parsePositiveInt(row.startTime);
      if (startTime === null) {
        errs.push({ row: i, field: 'startTime', message: 'Must be a positive Unix timestamp (seconds)' });
        rowValid = false;
      }

      const endTime = parsePositiveInt(row.endTime);
      if (endTime === null) {
        errs.push({ row: i, field: 'endTime', message: 'Must be a positive Unix timestamp (seconds)' });
        rowValid = false;
      }

      if (startTime !== null && endTime !== null && endTime <= startTime) {
        errs.push({ row: i, field: 'endTime', message: 'endTime must be after startTime' });
        rowValid = false;
      }

      if (rowValid && amount !== null && startTime !== null && endTime !== null) {
        const durationSecs = endTime - startTime;
        configs.push({
          recipient: row.recipient,
          amount: amount.toString(),
          startTime,
          endTime,
          ratePerSecond: (amount / BigInt(durationSecs)).toString(),
          ...(row.token ? { token: row.token } : {}),
        } as unknown as StreamConfig);
      }
    }

    setErrors(errs);
    return configs;
  }, []);

  return { validate, errors, isValid: errors.length === 0, reset };
}
