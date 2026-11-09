import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { NetworkContext } from '../../src/server/network';
import { OkxRestClient, OkxRestError } from '../../src/server/market/okx-rest';

interface MockServer {
  server: http.Server;
  url: string;
  requests: { url: string; count: number }[];
  counters: Record<string, number>;
}

async function startMock(options: { flakyCandles?: boolean } = {}): Promise<MockServer> {
  const requests: { url: string; count: number }[] = [];
  const counters: Record<string, number> = {};
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    counters[url.pathname] = (counters[url.pathname] ?? 0) + 1;
    requests.push({ url: url.toString(), count: counters[url.pathname] });
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/v5/public/time') {
      res.end(JSON.stringify({ code: '0', msg: '', data: [{ ts: '1794210000000' }] }));
      return;
    }
    if (url.pathname === '/api/v5/public/instruments') {
      const type = url.searchParams.get('instType');
      const data = type === 'SPOT'
        ? [{ instId: 'BTC-USDT', instType: 'SPOT', state: 'live', baseCcy: 'BTC', quoteCcy: 'USDT' }]
        : [{ instId: 'BTC-USDT-SWAP', instType: 'SWAP', state: 'live', ctVal: '0.01', ctValCcy: 'BTC' }];
      res.end(JSON.stringify({ code: '0', msg: '', data }));
      return;
    }
    if (url.pathname === '/api/v5/market/candles') {
      if (options.flakyCandles && counters[url.pathname] === 1) {
        res.statusCode = 500;
        res.end(JSON.stringify({ code: '50011', msg: 'temporary' }));
        return;
      }
      const base = 1_700_000_000_000;
      const data = [
        ['1700000300000', '100', '110', '90', '105', '10', '1', '1050', '0'],
        ['1700000000000', '99', '105', '98', '100', '9', '0.9', '950', '1'],
        ['1699999700000', '98', '100', '97', '99', '8', '0.8', '850', '1'],
      ];
      res.end(JSON.stringify({ code: '0', msg: '', data }));
      void base;
      return;
    }
    if (url.pathname === '/api/v5/market/history-candles') {
      const after = url.searchParams.get('after');
      const latest = 1_700_000_000_000;
      const step = 300_000;
      const afterTs = after ? Number(after) : latest + step;
      const data = Array.from({ length: 100 }, (_, index) => {
        const ts = afterTs - (index + 1) * step;
        return [String(ts), '100', '101', '99', '100.5', '10', '1', '1000', '1'];
      });
      res.end(JSON.stringify({ code: '0', msg: '', data }));
      return;
    }
    if (url.pathname === '/api/v5/market/no-permission') {
      res.statusCode = 400;
      res.end(JSON.stringify({ code: '50111', msg: 'bad request' }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ code: '404', msg: 'not found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { server, url: `http://127.0.0.1:${address.port}`, requests, counters };
}

function makeClient(url: string, retryBaseMs = 1): { client: OkxRestClient; network: NetworkContext } {
  const network = new NetworkContext();
  return {
    network,
    client: new OkxRestClient({
      baseUrl: url,
      network,
      getProxy: () => '',
      minIntervalMs: 0,
      timeoutMs: 3000,
      retryBaseMs,
    }),
  };
}

const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function mock(): Promise<MockServer> {
  const m = await startMock();
  servers.push(m.server);
  return m;
}

describe('OkxRestClient', () => {
  it('fetches server time and parses candlestick volume fields', async () => {
    const m = await mock();
    const { client, network } = makeClient(m.url);
    expect(await client.getServerTime()).toBe(1_794_210_000_000);
    const candles = await client.getCandles('BTC-USDT-SWAP', '5m', 3);
    expect(candles).toHaveLength(3);
    const latest = candles.at(-1)!;
    expect(latest.open).toBe(100);
    expect(latest.high).toBe(110);
    expect(latest.low).toBe(90);
    expect(latest.close).toBe(105);
    expect(latest.volume).toBe(1050);
    expect(latest.volCcyQuote).toBe(1050);
    expect(latest.confirm).toBe(false);
    network.dispose();
  });

  it('retries a 500 response and eventually succeeds', async () => {
    const m = await startMock({ flakyCandles: true });
    servers.push(m.server);
    const { client, network } = makeClient(m.url);
    const candles = await client.getCandles('BTC-USDT-SWAP', '5m', 3);
    expect(candles).toHaveLength(3);
    expect(m.counters['/api/v5/market/candles']).toBe(2);
    network.dispose();
  });

  it('surfaces OKX business errors and 4xx responses', async () => {
    const m = await mock();
    const { client, network } = makeClient(m.url);
    await expect(client.getServerTime()).resolves.toBeGreaterThan(0);
    // Unknown path gets a 404 from the mock.
    await expect(
      (client as any).fetchJson('/api/v5/market/no-permission', {}),
    ).rejects.toBeInstanceOf(OkxRestError);
    network.dispose();
  });

  it('fetches both spot and swap instrument lists', async () => {
    const m = await mock();
    const { client, network } = makeClient(m.url);
    const result = await client.getInstruments();
    expect(result.spots.map((i) => i.instId)).toContain('BTC-USDT');
    expect(result.swaps.map((i) => i.instId)).toContain('BTC-USDT-SWAP');
    network.dispose();
  });

  it('pages backward through history and returns confirmed candles in range', async () => {
    const m = await mock();
    const { client, network } = makeClient(m.url);
    const now = 1_700_000_000_000 + 120 * 300_000;
    const histories = await client.fetchHistoryWindow('BTC-USDT-SWAP', '5m', now - 250 * 300_000, now, 3);
    expect(histories.length).toBeGreaterThan(100);
    expect(histories[0].openTime).toBeLessThan(histories.at(-1)!.openTime);
    expect(histories.every((c) => c.confirm)).toBe(true);
    expect(m.requests.filter((r) => r.url.includes('history-candles')).length).toBeGreaterThan(1);
    network.dispose();
  });
});
