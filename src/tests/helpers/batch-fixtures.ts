/**
 * Shared test helpers for BuiltBatchTransaction fixtures and SDK mocks.
 *
 * #600: batch-submit.test.ts had to stub `new Transaction()` so placeholder
 * XDR strings wouldn't hit the real parser. Extracting these helpers so
 * every batch test doesn't re-derive the mock.
 */

import { vi } from 'vitest'
import type { BuiltBatchTransaction } from '../../batch-tx.js'

/**
 * Minimal BuiltBatchTransaction fixture (prepared=true).
 * Uses a placeholder XDR string that the mocked Transaction accepts.
 */
export function makeBuiltBatchTx(
  index: number,
  method = 'op',
): BuiltBatchTransaction {
  return { index, method, xdr: `XDR_${index}`, prepared: true }
}

/**
 * Returns a mock `Transaction` constructor that acts as a transparent
 * XDR carrier — `{ _xdr, toXDR: () => xdr }`.
 *
 * Use inside `vi.mock('@stellar/stellar-sdk', ...)` so that placeholder
 * XDR strings in fixtures don't hit the real stellar-sdk parser.
 */
export function mockTransactionConstructor() {
  return vi.fn().mockImplementation(function MockTransaction(
    this: unknown,
    xdr: string,
  ) {
    return { _xdr: xdr, toXDR: () => xdr }
  })
}

/**
 * Returns sendTransaction / getTransaction mock functions suitable for
 * `SorobanRpc.Server` in batch tests.
 */
export function mockBatchServer() {
  const mockSendTransaction = vi.fn()
  const mockGetTransaction = vi.fn()

  const MockServer = vi.fn().mockImplementation(function () {
    return {
      sendTransaction: mockSendTransaction,
      getTransaction: mockGetTransaction,
    }
  })

  return { MockServer, mockSendTransaction, mockGetTransaction }
}
