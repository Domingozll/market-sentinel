import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestRuntime, jsonRequest, type TestRuntime } from '../helpers/test-runtime';
import { FakeMarket, makeCandle, makeCandles, wait } from '../helpers/fake-market';
import type { DiscordTransport } from '../../src/server/alerts/discord';

const symbol = 'BTC-USDT-SWAP';
const endClose = Date.parse('2026-11-09T16:00:00+08:00');
const webhook = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnop';

function makeMarket(): FakeMarket {
  const market = new FakeMarket(endClose + 5000);
  const candles = makeCandles({ instId: symbol, timeframe: '5m', count: 320, endCloseTime: endClose });
  const last = candles.at(-1)!;
  candles[candles.length - 1] = { ...last, low: last.close - 0.01, high: last.close + 1 };
  market.seed(symbol, '5m', candles);
  return market;
}

function rulePayload(overrides: Record<string, unknown> = {}) {
  return {
    name: 'API 附加测试规则',
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

function transportReturning(statusRef: { value: number }): DiscordTransport {
  return {
    async fetch() {
      const status = statusRef.value;
      return new Response(JSON.stringify({ id: status < 300 ? 'extra-message' : undefined, message: 'mock' }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}

async function createAndTrigger(t: TestRuntime): Promise<string> {
  const created = await jsonRequest(t.runtime, { method: 'POST', url: '/api/rules', payload: rulePayload() });
  expect(created.statusCode).toBe(201);
  await wait(20);
  t.runtime.engine.flush();
  const market = t.runtime.market as FakeMarket;
  const prev = market.getLatestClosed(symbol, '5m')!;
  market.pushClosed(
    makeCandle({
      instId: symbol,
      timeframe: '5m',
      openTime: endClose,
      open: prev.close,
      high: prev.close + 1,
      low: 0,
      close: prev.close,
    }),
  );
  t.runtime.engine.flush();
  await wait(10);
  const events = await jsonRequest(t.runtime, { method: 'GET', url: '/api/events' });
  expect(events.body.total).toBe(1);
  return events.body.events[0].id as string;
}

let t: TestRuntime | null = null;
afterEach(async () => {
  await t?.cleanup();
  t = null;
});

describe('HTTP API: settings endpoints', () => {
  it('tests Discord and OKX and rejects invalid inputs', async () => {
    const statusRef = { value: 200 };
    t = await buildTestRuntime({ market: makeMarket(), transport: transportReturning(statusRef) });
    const invalidDiscord = await jsonRequest(t.runtime, {
      method: 'POST',
      url: '/api/settings/test-discord',
      payload: { webhookUrl: 'https://example.com/api/webhooks/1/x' },
    });
    expect(invalidDiscord.statusCode).toBe(400);

    await jsonRequest(t.runtime, {
      method: 'PUT',
      url: '/api/settings',
      payload: { discordWebhookUrl: webhook },
    });
    const discordTest = await jsonRequest(t.runtime, {
      method: 'POST',
      url: '/api/settings/test-discord',
      payload: {},
    });
    expect(discordTest.statusCode).toBe(200);
    expect(discordTest.body.ok).toBe(true);
    expect(discordTest.body.messageId).toBe('extra-message');

    const okxTest = await jsonRequest(t.runtime, {
      method: 'POST',
      url: '/api/settings/test-okx',
      payload: { proxyUrl: '' },
    });
    expect(okxTest.statusCode).toBe(200);
    expect(okxTest.body.ok).toBe(true);
    expect(typeof okxTest.body.latencyMs).toBe('number');

    const invalidProxy = await jsonRequest(t.runtime, {
      method: 'POST',
      url: '/api/settings/test-okx',
      payload: { proxyUrl: 'ftp://localhost:21' },
    });
    expect(invalidProxy.statusCode).toBe(400);

    const badSettings = await jsonRequest(t.runtime, {
      method: 'PUT',
      url: '/api/settings',
      payload: { defaultCooldownSec: -1 },
    });
    expect(badSettings.statusCode).toBe(400);
  });
});

describe('HTTP API: delivery retry', () => {
  it('turns a permanent failure into dead and allows manual retry to succeed', async () => {
    const statusRef = { value: 401 };
    t = await buildTestRuntime({ market: makeMarket(), transport: transportReturning(statusRef) });
    await jsonRequest(t.runtime, { method: 'PUT', url: '/api/settings', payload: { discordWebhookUrl: webhook } });
    const eventId = await createAndTrigger(t);
    await t.runtime.worker.processOnce();
    let event = await jsonRequest(t.runtime, { method: 'GET', url: `/api/events/${eventId}` });
    expect(event.body.event.delivery.status).toBe('dead');
    expect(event.body.event.delivery.lastHttpStatus).toBe(401);

    statusRef.value = 200;
    const retried = await jsonRequest(t.runtime, { method: 'POST', url: `/api/events/${eventId}/retry` });
    expect(retried.statusCode).toBe(200);
    expect(['pending', 'sending', 'sent']).toContain(retried.body.event.delivery.status);
    for (let i = 0; i < 50; i++) {
      event = await jsonRequest(t.runtime, { method: 'GET', url: `/api/events/${eventId}` });
      if (event.body.event.delivery.status === 'sent') break;
      await wait(20);
    }
    expect(event.body.event.delivery.status).toBe('sent');
    expect(event.body.event.delivery.externalMessageId).toBe('extra-message');
  });

  it('refuses retry when no webhook is configured and 404s unknown events', async () => {
    t = await buildTestRuntime({ market: makeMarket() });
    const eventId = await createAndTrigger(t);
    await t.runtime.worker.processOnce();
    const retry = await jsonRequest(t.runtime, { method: 'POST', url: `/api/events/${eventId}/retry` });
    expect(retry.statusCode).toBe(409);
    const missing = await jsonRequest(t.runtime, { method: 'POST', url: '/api/events/no-such-event/retry' });
    expect(missing.statusCode).toBe(404);
  });
});

describe('HTTP API: immutable event snapshots and filters', () => {
  it('keeps the event rule name and conditions after the rule is edited', async () => {
    const statusRef = { value: 200 };
    t = await buildTestRuntime({ market: makeMarket(), transport: transportReturning(statusRef) });
    await jsonRequest(t.runtime, { method: 'PUT', url: '/api/settings', payload: { discordWebhookUrl: webhook } });
    const created = await jsonRequest(t.runtime, { method: 'POST', url: '/api/rules', payload: rulePayload() });
    const ruleId = created.body.rule.id as string;
    await wait(20);
    t.runtime.engine.flush();
    const market = t.runtime.market as FakeMarket;
    const prev = market.getLatestClosed(symbol, '5m')!;
    market.pushClosed(makeCandle({
      instId: symbol, timeframe: '5m', openTime: endClose, open: prev.close,
      high: prev.close + 1, low: 0, close: prev.close,
    }));
    t.runtime.engine.flush();
    await wait(10);
    const before = await jsonRequest(t.runtime, { method: 'GET', url: '/api/events' });
    const event = before.body.events[0];
    expect(event.ruleName).toBe('API 附加测试规则');
    const update = await jsonRequest(t.runtime, {
      method: 'PUT',
      url: `/api/rules/${ruleId}`,
      payload: rulePayload({ name: '规则已改名', cooldownSec: 30 }),
    });
    expect(update.statusCode).toBe(200);
    const after = await jsonRequest(t.runtime, { method: 'GET', url: `/api/events/${event.id}` });
    expect(after.body.event.ruleName).toBe('API 附加测试规则');
    expect(JSON.stringify(after.body.event.conditions)).toBe(JSON.stringify(event.conditions));
  });

  it('filters events and 404s unknown API paths as JSON', async () => {
    t = await buildTestRuntime({ market: makeMarket() });
    const sent = await jsonRequest(t.runtime, { method: 'GET', url: '/api/events?status=sent' });
    expect(sent.statusCode).toBe(200);
    expect(sent.body.total).toBe(0);
    const missing = await jsonRequest(t.runtime, { method: 'GET', url: '/api/unknown' });
    expect(missing.statusCode).toBe(404);
    expect(missing.body.error).toBeTruthy();
  });
});
