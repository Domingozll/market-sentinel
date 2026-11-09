import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { MarketService } from '../../src/server/market/service';
import { OkxRestClient } from '../../src/server/market/okx-rest';
import { NetworkContext } from '../../src/server/network';
import { Store } from '../../src/server/store';
import { loadConfig } from '../../src/server/config';
import type { Candle } from '../../src/shared/types';
import { wait } from '../helpers/fake-market';

const TF = 300_000;
const serverNow = Math.floor(Date.now() / TF) * TF + 5000;
const lastClosedOpen = Math.floor(Date.now() / TF) * TF - TF;

function rowsForCandles(count: number): string[][] {
  return Array.from({ length: count }, (_, index) => {
    const openTime = lastClosedOpen - (count - 1 - index) * TF;
    const open = 100 + index * 0.1;
    const close = open + (index % 2 ? 0.2 : -0.1);
    return [
      String(openTime),
      String(open),
      String(Math.max(open, close) + 0.3),
      String(Math.min(open, close) - 0.3),
      String(close),
      '10',
      '1',
      '1000',
      '1',
    ];
  }).reverse();
}

describe('MarketService (REST + WebSocket)', () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it('loads history, subscribes over WebSocket, becomes healthy and ingests closed bars', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-market-'));
    const store = new Store(dir);
    const restRows = rowsForCandles(320);
    const sockets: WebSocket[] = [];
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/api/v5/public/time') {
        res.end(JSON.stringify({ code: '0', data: [{ ts: String(serverNow) }], msg: '' }));
        return;
      }
      if (url.pathname === '/api/v5/market/candles') {
        res.end(JSON.stringify({ code: '0', data: restRows, msg: '' }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ code: '404', msg: 'not found' }));
    });
    const wss = new WebSocketServer({ server, path: '/ws/v5/business' });
    wss.on('connection', (socket) => {
      sockets.push(socket);
      socket.on('message', (raw) => {
        const text = raw.toString();
        if (text === 'ping') {
          socket.send('pong');
          return;
        }
        const message = JSON.parse(text) as { op?: string; args?: { channel: string; instId: string }[] };
        if (message.op === 'subscribe') {
          for (const arg of message.args ?? []) socket.send(JSON.stringify({ event: 'subscribe', arg }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const config = loadConfig({
      dataDir: dir,
      okxRestBase: `http://127.0.0.1:${address.port}`,
      okxWsUrl: `ws://127.0.0.1:${address.port}/ws/v5/business`,
      reconcileIntervalMs: 3_600_000,
      port: 0 as unknown as number,
    });
    const network = new NetworkContext();
    const rest = new OkxRestClient({ baseUrl: config.okxRestBase, network, getProxy: () => '', minIntervalMs: 0 });
    const market = new MarketService({ config, store, rest, network, getProxy: () => '' });
    cleanups.push(async () => {
      await market.stop();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    await market.start();
    await market.ensurePairs([{ instId: 'BTC-USDT-SWAP', timeframe: '5m' }]);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const status = market.getPairStatus('BTC-USDT-SWAP', '5m');
      if (market.getConnectionState() === 'connected' && status.state === 'healthy') break;
      await wait(20);
    }
    expect(market.getConnectionState()).toBe('connected');
    const status = market.getPairStatus('BTC-USDT-SWAP', '5m');
    expect(status.state).toBe('healthy');
    expect(market.getClosedCandles('BTC-USDT-SWAP', '5m', 400).length).toBeGreaterThanOrEqual(300);
    expect(store.countCandles()).toBeGreaterThanOrEqual(300);

    const closedEvents: Candle[] = [];
    market.on('closed', (candle: Candle) => closedEvents.push(candle));
    const socket = sockets[0];
    expect(socket).toBeTruthy();
    const nextOpen = lastClosedOpen + TF;
    const row = [
      String(nextOpen),
      '132',
      '133',
      '131',
      '132.5',
      '12',
      '1.2',
      '1200',
      '1',
    ];
    socket.send(JSON.stringify({ arg: { channel: 'candle5m', instId: 'BTC-USDT-SWAP' }, data: [row] }));
    for (let i = 0; i < 100 && !closedEvents.length; i++) await wait(20);
    expect(closedEvents).toHaveLength(1);
    expect(closedEvents[0].close).toBe(132.5);
    expect(market.getLatestClosed('BTC-USDT-SWAP', '5m')?.openTime).toBe(nextOpen);
  });
});
