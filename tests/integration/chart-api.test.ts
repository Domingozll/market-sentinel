import { afterEach, describe, expect, it } from 'vitest';
import type { Candle } from '../../src/shared/types';
import { buildTestRuntime, jsonRequest, type TestRuntime } from '../helpers/test-runtime';
import { FakeMarket, makeCandles } from '../helpers/fake-market';

const start = Date.parse('2026-11-09T00:00:00+08:00');
const tf = 300_000;

function candles(count: number, end: number): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const openTime = end - (count - index - 1) * tf;
    return {
      instId: 'BTC-USDT-SWAP',
      timeframe: '5m',
      openTime,
      open: 100 + index,
      high: 101 + index,
      low: 99 + index,
      close: 100.5 + index,
      volume: 1000 + index,
      vol: 10 + index,
      volCcy: 10 + index,
      volCcyQuote: 1000 + index,
      confirm: true,
    };
  });
}

let runtime: TestRuntime | null = null;
afterEach(async () => {
  await runtime?.cleanup();
  runtime = null;
});

describe('GET /api/candles pagination', () => {
  it('returns a latest page and a before page without duplicate timestamps', async () => {
    runtime = await buildTestRuntime();
    const all = candles(30, start + 29 * tf);
    runtime.runtime.store.upsertCandles(all);

    const latest = await jsonRequest(runtime.runtime, {
      method: 'GET',
      url: '/api/candles?instId=BTC-USDT-SWAP&timeframe=5m&limit=20',
    });
    expect(latest.statusCode).toBe(200);
    expect(latest.body.candles).toHaveLength(20);
    expect(latest.body.candles.at(-1).openTime).toBe(all.at(-1)!.openTime);
    expect(latest.body.page.hasMore).toBe(true);
    expect(latest.body.page.oldest).toBe(all[10].openTime);

    const oldest = latest.body.candles[0].openTime;
    const older = await jsonRequest(runtime.runtime, {
      method: 'GET',
      url: `/api/candles?instId=BTC-USDT-SWAP&timeframe=5m&limit=20&before=${oldest}`,
    });
    expect(older.statusCode).toBe(200);
    expect(older.body.candles).toHaveLength(10);
    expect(older.body.candles.every((candle: Candle) => candle.openTime < oldest)).toBe(true);
    expect(older.body.page.hasMore).toBe(false);
    expect(new Set([...latest.body.candles, ...older.body.candles].map((candle: Candle) => candle.openTime)).size).toBe(30);
  });

  it('rejects invalid before and invalid timeframe', async () => {
    runtime = await buildTestRuntime();
    const badBefore = await jsonRequest(runtime.runtime, {
      method: 'GET',
      url: '/api/candles?instId=BTC-USDT-SWAP&timeframe=5m&limit=20&before=0',
    });
    expect(badBefore.statusCode).toBe(400);
    const badTimeframe = await jsonRequest(runtime.runtime, {
      method: 'GET',
      url: '/api/candles?instId=BTC-USDT-SWAP&timeframe=7m&limit=20',
    });
    expect(badTimeframe.statusCode).toBe(400);
  });
});


describe('GET /api/candles/stream', () => {
  it('opens an SSE stream and sends the latest candle snapshot', async () => {
    const market = new FakeMarket(start + 30 * tf);
    market.seed('BTC-USDT-SWAP', '5m', makeCandles({
      instId: 'BTC-USDT-SWAP',
      timeframe: '5m',
      count: 320,
      endCloseTime: start + 29 * tf,
    }));
    runtime = await buildTestRuntime({ market });
    const address = await runtime.runtime.app.listen({ port: 0, host: '127.0.0.1' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    try {
      const response = await fetch(
        `${address}/api/candles/stream?instId=BTC-USDT-SWAP&timeframe=5m`,
        { signal: controller.signal },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (!text.includes('event: candle')) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      expect(text).toContain('event: candle');
      expect(text).toContain('BTC-USDT-SWAP');
      await reader.cancel();
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  });
});
