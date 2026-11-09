import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { NetworkContext } from '../../src/server/network';
import { OkxWsClient } from '../../src/server/market/okx-ws';

const servers: WebSocketServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function waitFor(predicate: () => boolean, timeoutMs = 6000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timeout'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe('OkxWsClient reconnect', () => {
  it('reconnects and resubscribes after an unexpected close', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    servers.push(wss);
    await new Promise<void>((resolve) => wss.once('listening', resolve));
    const address = wss.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    let connections = 0;
    let resubscriptions = 0;
    wss.on('connection', (socket) => {
      connections++;
      socket.on('message', (raw) => {
        const text = raw.toString();
        if (text === 'ping') {
          socket.send('pong');
          return;
        }
        const message = JSON.parse(text) as { op?: string; args?: { channel: string; instId: string }[] };
        if (message.op === 'subscribe') {
          resubscriptions++;
          for (const arg of message.args ?? []) socket.send(JSON.stringify({ event: 'subscribe', arg }));
          // Force a disconnect after the first subscription to exercise reconnection.
          if (connections === 1) {
            setTimeout(() => socket.close(1011, 'test disconnect'), 20);
          }
        }
      });
    });
    const states: { state: string; reconnected: boolean }[] = [];
    const client = new OkxWsClient({
      url: `ws://127.0.0.1:${address.port}`,
      network: new NetworkContext(),
      getProxy: () => '',
      onCandle: () => undefined,
      onState: (state, reconnected) => states.push({ state, reconnected }),
      onError: () => undefined,
    });
    await client.setSubscriptions([{ instId: 'BTC-USDT-SWAP', timeframe: '5m' }]);
    await waitFor(() => connections >= 2 && resubscriptions >= 2);
    expect(states).toContainEqual({ state: 'connected', reconnected: false });
    expect(states).toContainEqual({ state: 'connected', reconnected: true });
    client.close();
  });
});
