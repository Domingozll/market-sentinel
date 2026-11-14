import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NetworkContext } from '../../src/server/network';
import {
  buildEventContent,
  buildEventPayload,
  PUSHPLUS_ENDPOINT,
  PushplusClient,
  type PushplusTransport,
} from '../../src/server/alerts/pushplus';
import type { EventView } from '../../src/shared/types';
import { buildTestRuntime, jsonRequest, type TestRuntime } from '../helpers/test-runtime';
import { FakeMarket, makeCandle, makeCandles, wait } from '../helpers/fake-market';

const webhookLikeToken = 'testtoken1234567890';

function eventFixture(): EventView {
  return {
    id: 'event-pushplus-1',
    ruleId: 'rule-1',
    ruleName: '5m 下轨触及',
    ruleVersion: 1,
    symbol: 'BTC-USDT-SWAP',
    triggerMode: 'close',
    triggerBarTs: 1_700_000_000_000,
    triggerAt: 1_700_000_300_000,
    price: 74_000,
    closeConfirmed: true,
    conditions: [
      {
        conditionId: 'c1',
        timeframe: '5m',
        leftSeries: 'price.low',
        rightSeries: 'bb.lower',
        leftValue: 73_900,
        rightValue: 74_000,
        cmp: 'lte',
        truth: true,
        barOpenTime: 1_700_000_000_000,
        barCloseTime: 1_700_000_300_000,
        leftParams: {},
        rightParams: { length: 20, mult: 2, slopeWindow: 1 },
      },
    ],
    expression: {
      kind: 'group',
      op: 'AND',
      children: [{
        kind: 'condition',
        id: 'c1',
        timeframe: '5m',
        left: { series: 'price.low' },
        cmp: 'lte',
        right: { type: 'series', series: 'bb.lower', params: { length: 20, mult: 2 } },
      }],
    },
    note: '测试备注',
    createdAt: 1_700_000_300_000,
    delivery: {
      status: 'pending',
      channel: 'pushplus',
      attempts: 0,
      lastHttpStatus: null,
      lastError: null,
      externalMessageId: null,
      nextAttemptAt: null,
      updatedAt: 1_700_000_300_000,
    },
  };
}

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function client(transport: PushplusTransport): PushplusClient {
  return new PushplusClient({
    network: new NetworkContext(),
    getProxy: () => '',
    transport,
  });
}

describe('PushPlus payloads', () => {
  it('builds a readable event text with conditions and disclaimer', () => {
    const content = buildEventContent(eventFixture());
    expect(content).toContain('规则：5m 下轨触及');
    expect(content).toContain('品种：BTC-USDT-SWAP');
    expect(content).toContain('条件快照：');
    expect(content).toContain('✓ 5m 最低价 ≤ 布林带下轨');
    expect(content).toContain('事件 ID：event-pushplus-1');
    expect(content).toContain('不构成投资建议');
    expect(content).not.toContain(webhookLikeToken);
  });

  it('uses the text template, WeChat channel and optional topic', () => {
    const payload = buildEventPayload(eventFixture(), webhookLikeToken, 'team-topic');
    expect(payload).toMatchObject({
      token: webhookLikeToken,
      template: 'txt',
      channel: 'wechat',
      topic: 'team-topic',
    });
    expect(String(payload.title)).toContain('BTC-USDT-SWAP');
  });
});

describe('PushPlus HTTP client', () => {
  it('sends to the fixed HTTPS endpoint and returns the flow id', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
      response(200, { code: 200, msg: '请求成功', data: 'flow-123' }));
    const result = await client({ fetch }).sendEvent(eventFixture(), webhookLikeToken);
    expect(result).toMatchObject({ ok: true, httpStatus: 200, messageId: 'flow-123' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(PUSHPLUS_ENDPOINT);
    expect(fetch.mock.calls[0][1].method).toBe('POST');
    const body = JSON.parse(String(fetch.mock.calls[0][1].body));
    expect(body.token).toBe(webhookLikeToken);
    expect(body.template).toBe('txt');
  });

  it('classifies business errors as non-retryable and HTTP 5xx/429 as retryable', async () => {
    const business = await client({ fetch: async () => response(200, { code: 900, msg: 'token无效' }) })
      .sendTest(webhookLikeToken);
    expect(business.ok).toBe(false);
    if (!business.ok) expect(business.retryable).toBe(false);

    const five = await client({ fetch: async () => response(503, { code: 503, msg: 'maintenance' }) })
      .sendTest(webhookLikeToken);
    expect(five.ok).toBe(false);
    if (!five.ok) expect(five.retryable).toBe(true);

    const limited = await client({
      fetch: async () => response(429, { code: 429, msg: 'limited' }, { 'retry-after': '3' }),
    }).sendTest(webhookLikeToken);
    expect(limited.ok).toBe(false);
    if (!limited.ok) {
      expect(limited.retryable).toBe(true);
      expect(limited.retryAfterMs).toBe(3000);
    }
  });

  it('rejects blank tokens and redacts tokens from transport errors', async () => {
    const fetch = vi.fn();
    const blank = await client({ fetch }).sendTest('');
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.retryable).toBe(false);
    expect(fetch).not.toHaveBeenCalled();

    const failed = await client({
      fetch: async () => { throw new Error(`proxy failed for ${webhookLikeToken}`); },
    }).sendTest(webhookLikeToken);
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.retryable).toBe(true);
      expect(failed.error).not.toContain(webhookLikeToken);
    }
  });
});

const symbol = 'BTC-USDT-SWAP';
const endClose = Date.parse('2026-11-09T16:00:00+08:00');

function makeMarket(): FakeMarket {
  const market = new FakeMarket(endClose + 5000);
  const candles = makeCandles({ instId: symbol, timeframe: '5m', count: 320, endCloseTime: endClose });
  const last = candles.at(-1)!;
  candles[candles.length - 1] = { ...last, low: last.close - 0.01, high: last.close + 1 };
  market.seed(symbol, '5m', candles);
  return market;
}

function rulePayload() {
  return {
    name: 'PushPlus 链路测试',
    symbols: [symbol],
    triggerMode: 'close',
    cooldownSec: 0,
    enabled: true,
    expression: {
      kind: 'group',
      op: 'AND',
      children: [{
        kind: 'condition',
        id: 'c1',
        timeframe: '5m',
        left: { series: 'price.low' },
        cmp: 'lte',
        right: { type: 'series', series: 'bb.lower', params: { length: 20, mult: 2 } },
      }],
    },
  };
}

let runtime: TestRuntime | null = null;
afterEach(async () => {
  await runtime?.cleanup();
  runtime = null;
});

describe('PushPlus API and outbox integration', () => {
  it('saves a masked token, tests the endpoint and delivers an event through PushPlus', async () => {
    const messages: Record<string, unknown>[] = [];
    const transport: PushplusTransport = {
      async fetch(_url, init) {
        messages.push(JSON.parse(String(init.body)));
        return response(200, { code: 200, msg: '请求成功', data: 'pushplus-flow-1' });
      },
    };
    runtime = await buildTestRuntime({ market: makeMarket(), pushplusTransport: transport });

    const saved = await jsonRequest(runtime.runtime, {
      method: 'PUT',
      url: '/api/settings',
      payload: {
        notificationChannel: 'pushplus',
        pushplusToken: webhookLikeToken,
        pushplusTopic: 'team-topic',
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body.settings).toMatchObject({
      notificationChannel: 'pushplus',
      notificationsConfigured: true,
      pushplusConfigured: true,
      pushplusTopic: 'team-topic',
    });
    expect(JSON.stringify(saved.body.settings)).not.toContain(webhookLikeToken);

    const tested = await jsonRequest(runtime.runtime, {
      method: 'POST',
      url: '/api/settings/test-pushplus',
      payload: {},
    });
    expect(tested.statusCode).toBe(200);
    expect(tested.body.ok).toBe(true);
    expect(messages[0].token).toBe(webhookLikeToken);

    const created = await jsonRequest(runtime.runtime, {
      method: 'POST',
      url: '/api/rules',
      payload: rulePayload(),
    });
    expect(created.statusCode).toBe(201);
    await wait(20);
    runtime.runtime.engine.flush();
    const market = runtime.runtime.market as FakeMarket;
    const previous = market.getLatestClosed(symbol, '5m')!;
    market.pushClosed(makeCandle({
      instId: symbol,
      timeframe: '5m',
      openTime: endClose,
      open: previous.close,
      high: previous.close + 1,
      low: 0,
      close: previous.close,
    }));
    runtime.runtime.engine.flush();
    await wait(10);
    const pending = await jsonRequest(runtime.runtime, { method: 'GET', url: '/api/events' });
    expect(pending.body.total).toBe(1);
    expect(pending.body.events[0].delivery.channel).toBe('pushplus');
    await runtime.runtime.worker.processOnce();
    const delivered = await jsonRequest(runtime.runtime, {
      method: 'GET',
      url: `/api/events/${pending.body.events[0].id}`,
    });
    expect(delivered.body.event.delivery).toMatchObject({
      channel: 'pushplus',
      status: 'sent',
      externalMessageId: 'pushplus-flow-1',
    });
    const eventMessage = messages.find((message) => String(message.title).includes('BTC-USDT-SWAP'));
    expect(eventMessage).toBeTruthy();
    expect(String(eventMessage?.content)).toContain('PushPlus 链路测试');
    expect(eventMessage?.token).toBe(webhookLikeToken);
  });

  it('rejects an invalid token without calling PushPlus', async () => {
    const fetch = vi.fn();
    runtime = await buildTestRuntime({
      market: makeMarket(),
      pushplusTransport: { fetch },
    });
    const badChannel = await jsonRequest(runtime.runtime, {
      method: 'PUT',
      url: '/api/settings',
      payload: { notificationChannel: 'telegram' },
    });
    expect(badChannel.statusCode).toBe(400);
    const badToken = await jsonRequest(runtime.runtime, {
      method: 'PUT',
      url: '/api/settings',
      payload: { pushplusToken: 'bad token' },
    });
    expect(badToken.statusCode).toBe(400);
    const invalid = await jsonRequest(runtime.runtime, {
      method: 'POST',
      url: '/api/settings/test-pushplus',
      payload: { pushplusToken: 'bad token' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});
