import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  isStreamMetadataURI,
  asStreamMetadataURI,
  type StreamMetadataURI,
  type StreamInvoiceMetadata,
  type IPFSInvoicePayload,
} from '../types/index.js';

function acceptInvoiceMetadata(_metadata: StreamInvoiceMetadata): void {}
function acceptInvoicePayload(_payload: IPFSInvoicePayload): void {}

describe('stream metadata types (#969)', () => {
  it('rejects a non-string or empty value as a StreamMetadataURI', () => {
    expect(isStreamMetadataURI('ipfs://bafybeigd...')).toBe(true);
    expect(isStreamMetadataURI('')).toBe(false);
    expect(isStreamMetadataURI(42)).toBe(false);
    expect(isStreamMetadataURI(undefined)).toBe(false);
  });

  it('casts a plain string to a branded StreamMetadataURI', () => {
    const uri: StreamMetadataURI = asStreamMetadataURI('ipfs://bafybeigd...');
    expectTypeOf(uri).toEqualTypeOf<StreamMetadataURI>();
    expect(isStreamMetadataURI(uri)).toBe(true);
  });

  it('requires invoiceNumber and ipfsCid on StreamInvoiceMetadata, with vatId optional', () => {
    expectTypeOf<StreamInvoiceMetadata['invoiceNumber']>().toEqualTypeOf<string>();
    expectTypeOf<StreamInvoiceMetadata['ipfsCid']>().toEqualTypeOf<string>();
    expectTypeOf<StreamInvoiceMetadata['vatId']>().toEqualTypeOf<string | undefined>();

    // @ts-expect-error invoiceNumber is required
    acceptInvoiceMetadata({ ipfsCid: 'bafybeigd...' });

    acceptInvoiceMetadata({ invoiceNumber: 'INV-001', ipfsCid: 'bafybeigd...' });
    acceptInvoiceMetadata({ invoiceNumber: 'INV-001', vatId: 'DE123456789', ipfsCid: 'bafybeigd...' });
    expect(true).toBe(true);
  });

  it('requires streamId and invoice on IPFSInvoicePayload, with uri optional', () => {
    // @ts-expect-error invoice is required
    acceptInvoicePayload({ streamId: 1n });

    const payload: IPFSInvoicePayload = {
      streamId: 1n,
      invoice: { invoiceNumber: 'INV-001', ipfsCid: 'bafybeigd...' },
    };
    acceptInvoicePayload(payload);
    acceptInvoicePayload({ ...payload, uri: asStreamMetadataURI('ipfs://bafybeigd...') });
    expect(payload.streamId).toBe(1n);
  });
});
