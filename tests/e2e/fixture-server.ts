import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntime, startRuntime } from '../../src/server/app';
import { FakeMarket, makeCandles } from '../helpers/fake-market';
import type { Candle } from '../../src/shared/types';
import type { DiscordTransport } from '../../src/server/alerts/discord';
import type { PushplusTransport } from '../../src/server/alerts/pushplus';

const symbol = 'BTC-USDT-SWAP';
const timeframe = '5m' as const;
const endClose = Math.floor(Date.now() / 300_000) * 300_000;
const realNow = endClose + 5_000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-e2e-'));
const market = new FakeMarket(realNow);
const candles = makeCandles({ instId: symbol, timeframe, count: 320, endCloseTime: endClose });
const last = candles[candles.length - 1];
candles[candles.length - 1] = { ...last, low: last.close - 0.01, high: last.close + 1 };
market.seed(symbol, timeframe, candles);
market.setHistory(symbol, timeframe, makeCandles({ instId: symbol, timeframe, count: 600, endCloseTime: endClose }));

const sentMessages: unknown[] = [];
const transport: DiscordTransport = {
  async fetch(_url, init) {
    try {
      sentMessages.push(JSON.parse(String(init.body)));
    } catch {
      sentMessages.push({ raw: String(init.body) });
    }
    return new Response(JSON.stringify({ id: `e2e-message-${sentMessages.length}` }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  },
};

const pushplusMessages: unknown[] = [];
const pushplusTransport: PushplusTransport = {
  async fetch(_url, init) {
    try {
      pushplusMessages.push(JSON.parse(String(init.body)));
    } catch {
      pushplusMessages.push({ raw: String(init.body) });
    }
    return new Response(JSON.stringify({ code: 200, msg: 'ok', data: `e2e-pushplus-${pushplusMessages.length}` }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  },
};

const runtime = await createRuntime({
  dataDir: dir,
  market,
  discordTransport: transport,
  pushplusTransport,
  serveStatic: true,
  logger: false,
  engineTiming: { settleMs: 80, tickThrottleMs: 80, baselineDelayMs: 80 },
  config: {
    host: '127.0.0.1',
    port: 8799,
    dataDir: dir,
    okxRestBase: 'https://openapi.okx.com',
    okxWsUrl: 'ws://127.0.0.1:1/ws/v5/business',
  },
});

runtime.app.post('/__test__/advance', async () => {
  const current = market.getLatestClosed(symbol, timeframe)!;
  const bar: Candle = {
    instId: symbol,
    timeframe,
    openTime: current.openTime + 300_000,
    open: current.close,
    high: current.close + 10,
    low: 0,
    close: current.close + 5,
    volume: 1500,
    vol: 150,
    volCcy: 150,
    volCcyQuote: 1500,
    confirm: true,
  };
  market.pushClosed(bar);
  return { ok: true, bar };
});

runtime.app.get('/__test__/state', async () => ({
  sentMessages,
  pushplusMessages,
  events: runtime.store.listEvents({ limit: 20 }),
  rules: runtime.store.listRules(),
}));

await startRuntime(runtime);
console.log(`[e2e-fixture] listening on http://127.0.0.1:8799 · data ${dir}`);

const shutdown = async () => {
  try {
    await runtime.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  }
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
