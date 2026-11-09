import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NetworkContext } from '../../src/server/network';
import {
  DiscordClient,
  buildEventPayload,
  buildTestPayload,
  type DiscordTransport,
} from '../../src/server/alerts/discord';
import { DeliveryWorker } from '../../src/server/alerts/worker';
import { Store } from '../../src/server/store';
import type { EventView, ExpressionNode } from '../../src/shared/types';
import { wait } from '../helpers/fake-market';

const webhook = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz';
const expression: ExpressionNode = {
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
};

function response(status: number, body: unknown = '', headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function client(transport: DiscordTransport, official = false): DiscordClient {
  return new DiscordClient({
    network: new NetworkContext(),
    getProxy: () => '',
    transport,
    allowNonOfficialUrls: !official,
  });
}

interface StoreHarness {
  dir: string;
  store: Store;
  event: EventView;
  cleanup: () => void;
}

function storeHarness(): StoreHarness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-discord-'));
  const store = new Store(dir);
  const event = {
    id: '00000000-0000-4000-8000-000000000010',
    ruleId: '00000000-0000-4000-8000-000000000001',
    ruleName: '测试规则',
    ruleVersion: 1,
    symbol: 'BTC-USDT-SWAP',
    triggerMode: 'close' as const,
    triggerBarTs: 1_700_000_000_000,
    triggerBarCloseTs: 1_700_000_300_000,
    triggerAt: 1_700_000_300_000,
    price: 74_000,
    expression,
    conditions: [
      {
        conditionId: 'c1',
        timeframe: '5m' as const,
        leftSeries: 'price.low' as const,
        rightSeries: 'bb.lower' as const,
        leftValue: 73_900,
        rightValue: 74_000,
        cmp: 'lte' as const,
        truth: true,
        barOpenTime: 1_700_000_000_000,
        barCloseTime: 1_700_000_300_000,
        leftParams: {},
        rightParams: { length: 20, mult: 2, slopeWindow: 1 },
      },
    ],
    note: '测试备注',
    closeConfirmed: true,
  };
  const inserted = store.insertEventIfNew(event, { status: 'pending', nextAttemptAt: 0 });
  if (!inserted.inserted) throw new Error('event insert failed');
  return {
    dir,
    store,
    event: store.getEvent(inserted.eventId)!,
    cleanup: () => {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('Discord payloads', () => {
  it('builds an embed without mentions and with condition snapshots', () => {
    const h = storeHarness();
    try {
      const payload = buildEventPayload(h.event) as any;
      expect(payload.allowed_mentions).toEqual({ parse: [] });
      expect(payload.embeds[0].title).toContain('BTC-USDT-SWAP');
      expect(payload.embeds[0].fields.some((f: any) => f.name === '条件快照')).toBe(true);
      expect(payload.embeds[0].footer.text).toContain('不构成投资建议');
      expect(JSON.stringify(payload)).toContain('测试规则');
    } finally {
      h.cleanup();
    }
  });

  it('builds a test payload that is clearly not a signal', () => {
    const payload = buildTestPayload(1_700_000_000_000) as any;
    expect(payload.embeds[0].title).toContain('测试消息');
    expect(payload.embeds[0].description).toContain('不是行情信号');
    expect(payload.allowed_mentions).toEqual({ parse: [] });
  });
});

describe('Discord HTTP handling', () => {
  it('sends a test and returns the Discord message id', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => response(200, { id: 'msg-1' }));
    const result = await client({ fetch }).sendTest(webhook);
    expect(result).toEqual({ ok: true, httpStatus: 200, messageId: 'msg-1' });
    const calledUrl = new URL(fetch.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get('wait')).toBe('true');
  });

  it('classifies 429 as retryable and preserves retry-after', async () => {
    const fetch = vi.fn(async () => response(429, { message: 'rate limited' }, { 'retry-after': '2' }));
    const result = await client({ fetch }).sendTest(webhook);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.retryAfterMs).toBe(2000);
      expect(result.error).toContain('429');
    }
  });

  it('classifies 5xx as retryable and 4xx as non-retryable', async () => {
    const five = await client({ fetch: async () => response(503) }).sendTest(webhook);
    expect(five.ok).toBe(false);
    if (!five.ok) expect(five.retryable).toBe(true);
    const four = await client({ fetch: async () => response(401) }).sendTest(webhook);
    expect(four.ok).toBe(false);
    if (!four.ok) expect(four.retryable).toBe(false);
  });

  it('redacts the webhook token from transport errors', async () => {
    const fetch = vi.fn(async () => {
      throw new Error(`connection failed for ${webhook}`);
    });
    const result = await client({ fetch }).sendTest(webhook);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain('abcdefghijklmnopqrstuvwxyz');
      expect(result.retryable).toBe(true);
    }
  });

  it('rejects non-Discord URLs when official validation is enabled', async () => {
    const result = await client({ fetch: async () => response(200) }, true).sendTest('https://example.com/api/webhooks/1/x');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(false);
  });
});

describe('DeliveryWorker', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it('sends a pending delivery and marks it sent', async () => {
    const h = storeHarness();
    cleanups.push(h.cleanup);
    const fakeClient = {
      sendEvent: vi.fn(async () => ({ ok: true as const, httpStatus: 200, messageId: 'msg-2' })),
    };
    const worker = new DeliveryWorker({
      store: h.store,
      discord: fakeClient as any,
      getWebhookUrl: () => webhook,
      minBackoffMs: 1,
    });
    await worker.processOnce();
    expect(fakeClient.sendEvent).toHaveBeenCalledTimes(1);
    expect(h.store.getEvent(h.event.id)!.delivery).toMatchObject({ status: 'sent', externalMessageId: 'msg-2' });
  });

  it('retries a retryable failure and then succeeds', async () => {
    const h = storeHarness();
    cleanups.push(h.cleanup);
    const send = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, httpStatus: 503, retryable: true, error: 'upstream down' })
      .mockResolvedValueOnce({ ok: true as const, httpStatus: 200, messageId: 'msg-3' });
    const worker = new DeliveryWorker({
      store: h.store,
      discord: { sendEvent: send } as any,
      getWebhookUrl: () => webhook,
      minBackoffMs: 1,
      baseBackoffMs: [1],
    });
    await worker.processOnce();
    let delivery = h.store.getEvent(h.event.id)!.delivery!;
    expect(delivery.status).toBe('pending');
    expect(delivery.attempts).toBe(1);
    await wait(5);
    await worker.processOnce();
    delivery = h.store.getEvent(h.event.id)!.delivery!;
    expect(delivery.status).toBe('sent');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('marks a permanent failure dead and can be retried manually', async () => {
    const h = storeHarness();
    cleanups.push(h.cleanup);
    const fakeClient = {
      sendEvent: vi.fn(async () => ({ ok: false as const, httpStatus: 401, retryable: false, error: 'unauthorized' })),
    };
    const worker = new DeliveryWorker({
      store: h.store,
      discord: fakeClient as any,
      getWebhookUrl: () => webhook,
      minBackoffMs: 1,
    });
    await worker.processOnce();
    expect(h.store.getEvent(h.event.id)!.delivery).toMatchObject({ status: 'dead', attempts: 1 });
    expect(h.store.getEvent(h.event.id)!.delivery?.lastHttpStatus).toBe(401);
    expect(h.store.retryDelivery(h.event.id)).toBe(true);
    expect(h.store.getEvent(h.event.id)!.delivery).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('marks delivery dead if no webhook is configured and never calls Discord', async () => {
    const h = storeHarness();
    cleanups.push(h.cleanup);
    const fakeClient = { sendEvent: vi.fn() };
    const worker = new DeliveryWorker({
      store: h.store,
      discord: fakeClient as any,
      getWebhookUrl: () => '',
      minBackoffMs: 1,
    });
    await worker.processOnce();
    expect(fakeClient.sendEvent).not.toHaveBeenCalled();
    expect(h.store.getEvent(h.event.id)!.delivery?.status).toBe('dead');
  });

  it('marks delivery dead after max attempts', async () => {
    const h = storeHarness();
    cleanups.push(h.cleanup);
    const send = vi.fn(async () => ({ ok: false as const, httpStatus: 500, retryable: true, error: 'server error' }));
    const worker = new DeliveryWorker({
      store: h.store,
      discord: { sendEvent: send } as any,
      getWebhookUrl: () => webhook,
      maxAttempts: 2,
      minBackoffMs: 1,
      baseBackoffMs: [1],
    });
    await worker.processOnce();
    await wait(5);
    await worker.processOnce();
    expect(send).toHaveBeenCalledTimes(2);
    expect(h.store.getEvent(h.event.id)!.delivery?.status).toBe('dead');
  });
});
