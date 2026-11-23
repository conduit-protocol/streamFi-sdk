import { describe, it, expect } from 'vitest';
import { SorobanRpc, xdr, nativeToScVal } from '@stellar/stellar-sdk';
import { extractDiagnosticMessage } from '../relayer/ErrorMapper.js';

type SimResponse = SorobanRpc.Api.SimulateTransactionResponse;

const BASE_FIELDS = { id: '1', latestLedger: 100, _parsed: true };

function successResponse(): SimResponse {
  return {
    ...BASE_FIELDS,
    events: [],
    transactionData: {},
    minResourceFee: '100',
    cost: { cpuInsns: '0', memBytes: '0' },
  } as unknown as SimResponse;
}

function errorResponse(error: string, events: xdr.DiagnosticEvent[] | string[] = []): SimResponse {
  return {
    ...BASE_FIELDS,
    error,
    events,
  } as unknown as SimResponse;
}

/** Duck-typed diagnostic event stub — real decoding only calls event().body().v0().{topics,data}(). */
function mockEvent(topics: unknown[], data: unknown): xdr.DiagnosticEvent {
  return {
    event: () => ({
      body: () => ({
        v0: () => ({
          topics: () => topics,
          data: () => data,
        }),
      }),
    }),
  } as unknown as xdr.DiagnosticEvent;
}

function malformedEvent(): xdr.DiagnosticEvent {
  return {
    event: () => {
      throw new Error('cannot decode');
    },
  } as unknown as xdr.DiagnosticEvent;
}

function realBase64DiagnosticEvent(dataText: string): string {
  const v0 = new xdr.ContractEventV0({
    topics: [nativeToScVal('some_topic', { type: 'symbol' })],
    data: nativeToScVal(dataText, { type: 'string' }),
  });
  const body = new (xdr.ContractEventBody as unknown as new (sw: number, val: unknown) => xdr.ContractEventBody)(0, v0);
  const contractEvent = new xdr.ContractEvent({
    ext: new (xdr.ExtensionPoint as unknown as new (sw: number) => xdr.ExtensionPoint)(0),
    contractId: null,
    type: xdr.ContractEventType.diagnostic(),
    body,
  });
  const diagnosticEvent = new xdr.DiagnosticEvent({ inSuccessfulContractCall: false, event: contractEvent });
  return diagnosticEvent.toXDR('base64');
}

describe('extractDiagnosticMessage (#921)', () => {
  it('returns a success fallback when the simulation did not fail', () => {
    expect(extractDiagnosticMessage(successResponse())).toBe(
      'Simulation succeeded; no diagnostic message to extract.',
    );
  });

  it('falls back to the raw RPC error when there are no diagnostic events', () => {
    expect(extractDiagnosticMessage(errorResponse('contract trapped'))).toBe('contract trapped');
  });

  it('falls back to a generic message when no error string is present', () => {
    expect(extractDiagnosticMessage(errorResponse(undefined as unknown as string))).toBe(
      'Unknown Soroban RPC error',
    );
  });

  it('appends host function call stack details decoded from diagnostic events', () => {
    const event = mockEvent(
      [{ toString: () => 'withdraw' }],
      { toString: () => 'insufficient balance' },
    );
    const message = extractDiagnosticMessage(errorResponse('contract trapped', [event]));
    expect(message).toContain('contract trapped');
    expect(message).toContain('Call stack:');
    expect(message).toContain('withdraw');
    expect(message).toContain('insufficient balance');
  });

  it('appends auth failure reasons decoded from diagnostic events', () => {
    const event = mockEvent([], { toString: () => 'source account is not authorized' });
    const message = extractDiagnosticMessage(errorResponse('auth failed', [event]));
    expect(message).toContain('auth failed');
    expect(message).toContain('Auth failure:');
    expect(message).toContain('not authorized');
  });

  it('skips malformed diagnostic events and still returns a readable fallback', () => {
    const message = extractDiagnosticMessage(errorResponse('host invocation failed', [malformedEvent()]));
    expect(message).toBe('host invocation failed');
  });

  it('decodes base64-encoded diagnostic events without throwing', () => {
    const b64 = realBase64DiagnosticEvent('insufficient balance to complete withdrawal');
    const message = extractDiagnosticMessage(errorResponse('contract trapped', [b64]));
    expect(message).toContain('contract trapped');
    expect(message).toContain('Call stack:');
  });
});
