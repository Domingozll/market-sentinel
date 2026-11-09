import { afterEach, describe, expect, it } from 'vitest';
import { buildTestRuntime, jsonRequest, type TestRuntime } from '../helpers/test-runtime';
import { FakeMarket, makeCandle, makeCandles, wait } from '../helpers/fake-market';
import type { DiscordTransport } from '../../src/server/alerts/discord';

const endClose = Date.parse('2026-11-09T15:00:00+08:00');
const symbol = 'BTC-USDT-SWAP';
const webhook = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz';

function rulePayload(overrides: Record<string, unknown> = {}) {
  return {
    name: 'API 下轨触及',
    symbols: [symbol],
    triggerMode: 'close',
    cooldownSec: 0,
    enabled: true,
    expression: {
      kind: 'group',
      op: 'AND',
      children: [
        {
          kind: 'condition',
          id: 'c1',
          timeframe: '5m',
          left: { series: 'price.low' },
          cmp: 'lte',
          right: { type: 'series', series: 'bb.lower', params: { length: 20, mult: 2 } },
        },
      ],
    },
    ...overrides,
  };
}

function makeMarket(): FakeMarket {
  const market = new FakeMarket(endClose + 5000);
  const candles = makeCandles({ instId: symbol, timeframe: '5m', count: 320, endCloseTime: endClose });
  const last = candles.at(-1)!;
  candles[candles.length - 1] = { ...last, low: last.close - 0.01, high: last.close + 1 };
  market.seed(symbol, '5m', candles);
  return market;
}

function mockTransport(): { transport: DiscordTransport; calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    transport: {
      async fetch(url, init) {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ id: `msg-${calls.length}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    },
  };
}

let t: TestRuntime | null = null;
afterEach(async () => {
  await t?.cleanup();
  t = null;
});

describe('HTTP API: settings and security', () => {
  it('never returns the full webhook and masks it', async () => {
    t = await buildTestRuntime();
    const saved = await jsonRequest(t.runtime, {
      method: 'PUT',
      url: '/api/settings',
      payload: { discordWebhookUrl: webhook, defaultCooldownSec: 300 },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body.settings.discordConfigured).toBe(true);
    expect(JSON.stringify(saved.body)).not.toContain('abcdefghijklmnopqrstuvwxyz');

    const got = await jsonRequest(t.runtime, { method: 'GET', url: '/api/settings' });
    expect(got.statusCode).toBe(200);
    expect(got.body.settings.discordWebhookMasked).toContain('wxyz');
    expect(JSON.stringify(got.body)).not.toContain(webhook);
  });

  it('rejects a non-Discord webhook', async () => {
    t = await buildTestRuntime();
    const response = await jsonRequest(t.runtime, {
      method: 'PUT',
      url: '/api/settings',
      payload: { discordWebhookUrl: 'https://evil.example.com/api/webhooks/1/token' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects cross-site mutation requests', async () => {
    t = await buildTestRuntime();
    const response = await jsonRequest(t.runtime, {
      method: 'POST',
      url: '/api/rules',
      payload: rulePayload(),
      headers: { origin: 'https://evil.example.com', host: '127.0.0.1:8787' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('does not expose webhook in diagnostics', async () => {
    t = await buildTestRuntime();
    await jsonRequest(t.runtime, { method: 'PUT', url: '/api/settings', payload: { discordWebhookUrl: webhook } });
    const response = await jsonRequest(t.runtime, { method: 'GET', url: '/api/diagnostics' });
    expect(response.statusCode).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });
});

describe('HTTP API: rules', () => {
  it('creates, validates, pauses, resumes, duplicates and archives a rule', async () => {
    t = await buildTestRuntime({ market: makeMarket() });
    const invalid = await jsonRequest(t.runtime, {
      method: 'POST',
      url: '/api/rules',
      payload: rulePayload({ name: 'x', cooldownSec: -1 }),
    });
    expect(invalid.statusCode).toBe(400);

    const created = await jsonRequest(t.runtime, { method: 'POST', url: '/api/rules', payload: rulePayload() });
    expect(created.statusCode).toBe(201);
    const id = created.body.rule.id as string;
    expect(id).toMatch(/[0-9a-f-]{36}/);
    await wait(20);
    t.runtime.engine.flush();

    const list = await jsonRequest(t.runtime, { method: 'GET', url: '/api/rules' });
    expect(list.statusCode).toBe(200);
    expect(list.body.rules).toHaveLength(1);
    expect(list.body.rules[0].summary).toContain('布林带下轨');
    expect(['armed', 'warming']).toContain(list.body.rules[0].ruleStatus);

    const paused = await jsonRequest(t.runtime, {
      method: 'PATCH',
      url: `/api/rules/${id}/enabled`,
      payload: { enabled: false },
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.body.rule.ruleStatus).toBe('paused');

    const resumed = await jsonRequest(t.runtime, {
      method: 'PATCH',
      url: `/api/rules/${id}/enabled`,
      payload: { enabled: true },
    });
    expect(resumed.statusCode).toBe(200);
    await wait(20);
    t.runtime.engine.flush();

    const duplicate = await jsonRequest(t.runtime, {
      method: 'POST',
      url: `/api/rules/${id}/duplicate`,
    });
    expect(duplicate.statusCode).toBe(201);
    expect(duplicate.body.rule.enabled).toBe(false);

    const deleted = await jsonRequest(t.runtime, { method: 'DELETE', url: `/api/rules/${id}` });
    expect(deleted.statusCode).toBe(200);
    const afterDelete = await jsonRequest(t.runtime, { method: 'GET', url: `/api/rules/${id}` });
    expect(afterDelete.statusCode).toBe(404);
  });

  it('previews a draft without saving or notifying', async () => {
    t = await buildTestRuntime({ market: makeMarket() });
    await wait(20);
    const response = await jsonRequest(t.runtime, {
      method: 'POST',
      url: '/api/rules/preview',
      payload: rulePayload({ enabled: undefined }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body.results[0].symbol).toBe(symbol);
    expect(response.body.results[0].ok).toBe(true);
    const list = await jsonRequest(t.runtime, { method: 'GET', url: '/api/rules' });
    expect(list.body.rules).toHaveLength(0);
  });

  it('triggers an event, sends through the worker, and returns the delivered event', async () => {
    const mock = mockTransport();
    t = await buildTestRuntime({ market: makeMarket(), transport: mock.transport });
    await jsonRequest(t.runtime, { method: 'PUT', url: '/api/settings', payload: { discordWebhookUrl: webhook } });
    const created = await jsonRequest(t.runtime, { method: 'POST', url: '/api/rules', payload: rulePayload() });
    const id = created.body.rule.id as string;
    await wait(20);
    t.runtime.engine.flush();

    const market = t.runtime.market as FakeMarket;
    const prev = market.getLatestClosed(symbol, '5m')!;
    const bar = makeCandle({
      instId: symbol,
      timeframe: '5m',
      openTime: endClose,
      open: prev.close,
      high: prev.close + 1,
      low: 0,
      close: prev.close,
    });
    market.pushClosed(bar);
    t.runtime.engine.flush();
    await wait(10);

    const events = await jsonRequest(t.runtime, { method: 'GET', url: '/api/events' });
    expect(events.statusCode).toBe(200);
    expect(events.body.total).toBe(1);
    const eventId = events.body.events[0].id as string;
    expect(events.body.events[0].delivery.status).toBe('pending');

    await t.runtime.worker.processOnce();
    const detail = await jsonRequest(t.runtime, { method: 'GET', url: `/api/events/${eventId}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.body.event.delivery.status).toBe('sent');
    expect(detail.body.event.conditions).toHaveLength(1);
    expect(mock.calls).toHaveLength(1);
    // Discord payload contains no allowed mention expansion.
    expect(mock.calls[0].body.allowed_mentions).toEqual({ parse: [] });
    expect(mock.calls[0].body.embeds[0].title).toContain(symbol);

    const dashboard = await jsonRequest(t.runtime, { method: 'GET', url: '/api/dashboard' });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body.stats.todayEvents).toBe(1);
    expect(dashboard.body.stats.deliverySuccess).toBe(1);

    t.runtime.engine.flush();
    expect((await jsonRequest(t.runtime, { method: 'GET', url: '/api/events' })).body.total).toBe(1);
  });
});

describe('HTTP API: data and trial', () => {
  it('serves instruments and candles', async () => {
    const market = makeMarket();
    t = await buildTestRuntime({ market });
    const instruments = await jsonRequest(t.runtime, { method: 'GET', url: '/api/instruments?query=ETH' });
    expect(instruments.statusCode).toBe(200);
    expect(instruments.body.instruments.some((i: any) => i.instId === 'ETH-USDT-SWAP')).toBe(true);
    const candles = await jsonRequest(t.runtime, { method: 'GET', url: `/api/candles?instId=${symbol}&timeframe=5m&limit=100` });
    expect(candles.statusCode).toBe(200);
    expect(candles.body.candles.length).toBe(100);
  });

  it('runs a close-signal trial without inserting events', async () => {
    const market = makeMarket();
    const historyEnd = endClose + 8 * 86_400_000;
    const history = makeCandles({ instId: symbol, timeframe: '5m', count: 600, endCloseTime: historyEnd });
    market.setHistory(symbol, '5m', history);
    market.setNow(historyEnd + 5000);
    t = await buildTestRuntime({ market });
    const response = await jsonRequest(t.runtime, {
      method: 'POST',
      url: '/api/rules/trial',
      payload: { ...rulePayload({ enabled: undefined }), symbol, windowDays: 1 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toHaveProperty('triggerCount');
    expect(Array.isArray(response.body.triggers)).toBe(true);
    expect(response.body.candles.length).toBeGreaterThan(0);
    expect(response.body.warning).toContain('盈亏');
    const eventCount = await jsonRequest(t.runtime, { method: 'GET', url: '/api/events' });
    expect(eventCount.body.total).toBe(0);
  });
});
