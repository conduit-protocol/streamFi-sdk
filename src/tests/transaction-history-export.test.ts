import { describe, it, expect } from 'vitest';
import {
  exportTransactionsToCsv,
  exportTransactionsToJson,
  formatAddress,
  formatAmount,
  type TransactionRecord,
} from '../dashboard/transaction-history.js';

describe('Transaction History Export Helpers (#808)', () => {
  const mockTransactions: TransactionRecord[] = [
    {
      id: 'tx-1',
      hash: 'hash-abc-123',
      streamId: 'stream-001',
      kind: 'CREATE',
      direction: 'OUT',
      status: 'CONFIRMED',
      amount: '100000000', // 10 XLM in 7 decimals
      asset: 'XLM',
      counterparty: 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H',
      timestamp: 1700000000000,
    },
    {
      id: 'tx-2',
      hash: 'hash-def-456',
      streamId: 'stream-002',
      kind: 'WITHDRAW',
      direction: 'IN',
      status: 'CONFIRMED',
      amount: '2500000', // 0.25 XLM
      asset: 'USDC',
      counterparty: 'GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA',
      timestamp: 1700001000000,
    },
  ];

  describe('exportTransactionsToCsv', () => {
    it('exports CSV with headers and formatted values by default', () => {
      const csv = exportTransactionsToCsv(mockTransactions);
      const lines = csv.split('\n');

      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe('id,hash,streamId,kind,direction,status,amount,asset,counterparty,timestamp');

      // Verify row 1 uses formatAmount and formatAddress
      const row1 = lines[1].split(',');
      expect(row1[0]).toBe('tx-1');
      expect(row1[1]).toBe('hash-abc-123');
      expect(row1[2]).toBe('stream-001');
      expect(row1[3]).toBe('CREATE');
      expect(row1[4]).toBe('OUT');
      expect(row1[5]).toBe('CONFIRMED');
      expect(row1[6]).toBe(formatAmount('100000000'));
      expect(row1[7]).toBe('XLM');
      expect(row1[8]).toBe(formatAddress(mockTransactions[0].counterparty));
      expect(row1[9]).toBe('1700000000000');
    });

    it('respects options: raw amounts, full addresses, timestamps, and header suppression', () => {
      const csv = exportTransactionsToCsv(mockTransactions, {
        formatAmounts: false,
        formatAddresses: false,
        formatTimestamps: true,
        includeHeader: false,
      });

      const lines = csv.split('\n');
      expect(lines).toHaveLength(2);

      const row1 = lines[0].split(',');
      expect(row1[0]).toBe('tx-1');
      expect(row1[6]).toBe('100000000'); // raw amount
      expect(row1[8]).toBe(mockTransactions[0].counterparty); // full address
      expect(row1[9]).toMatch(/^\d{4}-\d{2}-\d{2}/); // formatted ISO timestamp
    });

    it('escapes cells containing commas, quotes, or newlines', () => {
      const trickyTxs: TransactionRecord[] = [
        {
          id: 'tx-quote',
          hash: 'hash,"with,quotes"',
          streamId: 'stream\nline',
          kind: 'UNKNOWN',
          direction: 'UNKNOWN',
          status: 'PENDING',
          amount: '1000',
          asset: 'MY,COIN',
          counterparty: 'GAAZI4TCR3TY',
          timestamp: 0,
        },
      ];

      const csv = exportTransactionsToCsv(trickyTxs);
      expect(csv).toContain('"hash,""with,quotes"""');
      expect(csv).toContain('"stream\nline"');
      expect(csv).toContain('"MY,COIN"');
    });

    it('returns only headers when transactions list is empty', () => {
      const csv = exportTransactionsToCsv([]);
      expect(csv).toBe('id,hash,streamId,kind,direction,status,amount,asset,counterparty,timestamp');
    });
  });

  describe('exportTransactionsToJson', () => {
    it('exports formatted JSON array by default', () => {
      const jsonStr = exportTransactionsToJson(mockTransactions);
      const parsed = JSON.parse(jsonStr);

      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].amount).toBe(formatAmount(mockTransactions[0].amount));
      expect(parsed[0].counterparty).toBe(formatAddress(mockTransactions[0].counterparty));
      expect(parsed[0].id).toBe('tx-1');
    });

    it('supports compact JSON (pretty: false) and raw formatting options', () => {
      const jsonStr = exportTransactionsToJson(mockTransactions, {
        pretty: false,
        formatAmounts: false,
        formatAddresses: false,
      });

      expect(jsonStr).not.toContain('\n');
      const parsed = JSON.parse(jsonStr);
      expect(parsed[0].amount).toBe('100000000');
      expect(parsed[0].counterparty).toBe(mockTransactions[0].counterparty);
    });

    it('handles boolean shorthand for pretty', () => {
      const compact = exportTransactionsToJson(mockTransactions, false);
      expect(compact).not.toContain('\n');
      const pretty = exportTransactionsToJson(mockTransactions, true);
      expect(pretty).toContain('\n');
    });

    it('handles empty or null transactions gracefully', () => {
      expect(exportTransactionsToJson([])).toBe('[]');
      expect(exportTransactionsToJson(null as unknown as TransactionRecord[])).toBe('[]');
    });
  });
});
