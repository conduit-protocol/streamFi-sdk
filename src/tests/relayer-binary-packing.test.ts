/**
 * Tests for optional binary message packing in WebSocketRelayer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  WebSocketRelayer,
  packMessage,
  unpackMessage,
  type WebSocketMessage,
} from '../relayer/WebSocketRelayer.js';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readyState = 1;
  binaryType?: string;
  sent: unknown[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: unknown }) => void;
  onclose?: () => void;
  onerror?: () => void;

  constructor(_url: string) {
    MockWebSocket.instances.push(this);
    // Mirrors a real WebSocket opening asynchronously-ish; connect() resolves
    // once we invoke onopen in createRelayer().
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.onopen?.();
  }

  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
}

async function createRelayer(options?: ConstructorParameters<typeof WebSocketRelayer>[1]) {
  const relayer = new WebSocketRelayer('ws://localhost:8080', {
    heartbeatIntervalMs: 0,
    ...options,
  });
  const connecting = relayer.connect();
  // establishConnection() runs after an await in acquireLock(); let that
  // microtask flush so the mock socket has been constructed.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
  ws.open();
  await connecting;
  return { relayer, ws };
}

describe('binary frame codec', () => {
  it('round-trips object, string, bigint and null payloads (with an id)', () => {
    const messages: WebSocketMessage[] = [
      { type: 'balance', payload: { withdrawable: '1234' }, id: 'm1' },
      { type: 'status', payload: 'active' },
      { type: 'tick', payload: 9007199254740993n, id: 'm2' },
      { type: 'ping', payload: null },
    ];
    for (const message of messages) {
      expect(unpackMessage(packMessage(message))).toEqual(message);
    }
  });

  it('packs more tightly than the JSON envelope for a typical update', () => {
    const message: WebSocketMessage = {
      type: 'stream_balance',
      payload: { withdrawable: '1234' },
      id: 'm1',
    };
    const jsonSize = new TextEncoder().encode(JSON.stringify(message)).byteLength;
    expect(packMessage(message).byteLength).toBeLessThan(jsonSize);
  });

  it('rejects malformed frames', () => {
    expect(unpackMessage(new ArrayBuffer(2))).toBeNull();
    const garbage = new TextEncoder().encode('{"type":"not-binary"}');
    expect(unpackMessage(garbage)).toBeNull();
    const truncated = new Uint8Array(packMessage({ type: 'x', payload: 'value' })).slice(0, 8);
    expect(unpackMessage(truncated)).toBeNull();
  });
});

describe('WebSocketRelayer encoding modes', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends and receives binary frames when binary mode is enabled', async () => {
    const { relayer, ws } = await createRelayer({ binary: true });
    expect(ws.binaryType).toBe('arraybuffer');

    const handler = vi.fn();
    relayer.on('balance', handler);
    await relayer.send({ type: 'balance', payload: { amount: 5n }, id: 'a' });
    const outbound = ws.sent[0];
    expect(outbound).toBeInstanceOf(ArrayBuffer);

    ws.emit(outbound);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      type: 'balance',
      payload: { amount: '5' },
      id: 'a',
    });
    relayer.destroy();
  });

  it('keeps JSON frames byte-for-byte in the default mode', async () => {
    const { relayer, ws } = await createRelayer();
    const message: WebSocketMessage = { type: 'update', payload: { n: 1 }, id: 'j1' };
    const handler = vi.fn();
    relayer.on('update', handler);
    await relayer.send(message);
    expect(ws.sent[0]).toBe(JSON.stringify(message));

    ws.emit(JSON.stringify(message));
    expect(handler).toHaveBeenCalledWith(message);
    relayer.destroy();
  });

  it('still decodes JSON text inbound while in binary mode', async () => {
    const { relayer, ws } = await createRelayer({ messageEncoding: 'binary' });
    const handler = vi.fn();
    relayer.on('legacy', handler);
    ws.emit(JSON.stringify({ type: 'legacy', payload: 'ok' }));
    expect(handler).toHaveBeenCalledWith({ type: 'legacy', payload: 'ok' });
    relayer.destroy();
  });
});
