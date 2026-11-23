import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketRelayer } from '../relayer/WebSocketRelayer.js';

/** A socket whose close() never fires onclose, like a half-open TCP link. */
function createHalfOpenWs() {
  const ws: any = {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(() => { ws.readyState = 3; }),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  return ws;
}

describe('WebSocketRelayer heartbeat watchdog', () => {
  let sockets: any[];
  let relayer: WebSocketRelayer;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    sockets = [];
    (globalThis as any).WebSocket = vi.fn(function () {
      const ws = createHalfOpenWs();
      sockets.push(ws);
      setTimeout(() => ws.onopen?.(), 0);
      return ws;
    });
    relayer = new WebSocketRelayer('ws://relay', {
      heartbeatIntervalMs: 1000,
      heartbeatTimeoutMs: 200,
      reconnectDelayMs: 10,
    });
  });

  afterEach(() => {
    relayer.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function connect() {
    const p = relayer.connect();
    await vi.advanceTimersByTimeAsync(1);
    await p;
  }

  it('sends a ping each interval', async () => {
    await connect();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets[0].send).toHaveBeenCalledWith(JSON.stringify({ type: 'ping' }));
  });

  it('stays connected when a pong arrives in time', async () => {
    await connect();
    await vi.advanceTimersByTimeAsync(1000);
    sockets[0].onmessage({ data: JSON.stringify({ type: 'pong', payload: null }) });
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets[0].close).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
  });

  it('reconnects even though close() never fires onclose when the pong is missed', async () => {
    await connect();
    await vi.advanceTimersByTimeAsync(1000 + 200);
    expect(sockets[0].close).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(sockets).toHaveLength(2);
    expect(relayer.state.connected).toBe(true);
  });

  it('treats any inbound message as proof of liveness', async () => {
    await connect();
    await vi.advanceTimersByTimeAsync(1000);
    sockets[0].onmessage({ data: JSON.stringify({ type: 'event', payload: 1 }) });
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets[0].close).not.toHaveBeenCalled();
  });

  it('does not ping when heartbeatIntervalMs is 0', async () => {
    relayer.destroy();
    relayer = new WebSocketRelayer('ws://relay', { heartbeatIntervalMs: 0 });
    await connect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets.at(-1).send).not.toHaveBeenCalled();
  });
});
