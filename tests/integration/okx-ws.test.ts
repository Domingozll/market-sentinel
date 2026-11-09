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

function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timeout'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('OkxWsClient', () => {
  it('subscribes to candle channels and parses pushed rows', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    servers.push(wss);
    await new Promise<void>((resolve) => wss.once('listening', resolve));
    const address = wss.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const subscriptions: string[] = [];
    wss.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const text = raw.toString();
        if (text === 'ping') {
          socket.send('pong');
          return;
        }
        const message = JSON.parse(text) as { op?: string; args?: { channel: string; instId: string }[] };
        if (message.op === 'subscribe') {
          for (const arg of message.args ?? []) {
            subscriptions.push(`${arg.channel}:${arg.instId}`);
            socket.send(JSON.stringify({ event: 'subscribe', arg, connId: 'mock' }));
            const row = ['1794210000000', '100', '110', '90', '105', '10', '1', '1050', '0'];
            socket.send(JSON.stringify({ arg, data: [row] }));
          }
        }
      });
    });
    const states: string[] = [];
    const candles: { instId: string; timeframe: string; row: string[] }[] = [];
    const errors: string[] = [];
    const client = new OkxWsClient({
      url: `ws://127.0.0.1:${address.port}`,
      network: new NetworkContext(),
      getProxy: () => '',
      onCandle: (instId, timeframe, row) => candles.push({ instId, timeframe, row }),
      onState: (state) => states.push(state),
      onError: (error) => errors.push(error.message),
    });
    await client.setSubscriptions([{ instId: 'BTC-USDT-SWAP', timeframe: '5m' }]);
    await waitFor(() => candles.length > 0 && states.includes('connected'));
    expect(subscriptions).toContain('candle5m:BTC-USDT-SWAP');
    expect(candles[0]).toMatchObject({ instId: 'BTC-USDT-SWAP', timeframe: '5m' });
    expect(candles[0].row).toHaveLength(9);
    expect(states).toContain('connecting');
    expect(states).toContain('connected');
    expect(errors).toEqual([]);
    client.close();
  });
});
