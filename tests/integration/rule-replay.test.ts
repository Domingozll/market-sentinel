import { afterEach, describe, expect, it } from 'vitest';
import { runTrial } from '../../src/server/trial';
import { bollingerBands } from '../../src/server/indicators';
import type { ConditionGroup, RuleDraft } from '../../src/shared/types';
import { buildTestRuntime, jsonRequest, type TestRuntime } from '../helpers/test-runtime';
import { FakeMarket, makeCandles } from '../helpers/fake-market';

const symbol = 'BTC-USDT-SWAP';
const endClose = Date.parse('2026-11-09T16:00:00+08:00');

function preparedMarket() {
  const candles = makeCandles({ instId: symbol, timeframe: '5m', count: 500, endCloseTime: endClose });
  const bands = bollingerBands(candles, { length: 20, mult: 2 });
  for (const index of [250, 300, 450]) {
    const lower = bands.lower[index];
    if (lower !== null) candles[index] = { ...candles[index], low: lower - 1 };
  }
  const market = new FakeMarket(endClose + 5000);
  market.setHistory(symbol, '5m', candles);
  return market;
}

const expression: ConditionGroup = {
  kind: 'group',
  op: 'AND',
  children: [{
    kind: 'condition',
    id: 'touch',
    timeframe: '5m',
    left: { series: 'price.low' },
    cmp: 'lte',
    right: { type: 'series', series: 'bb.lower', params: { length: 20, mult: 2 } },
  }],
};

const draft: RuleDraft = {
  name: '回放规则',
  symbols: [symbol],
  triggerMode: 'close',
  cooldownSec: 0,
  expression,
  note: '',
};

let runtime: TestRuntime | null = null;
afterEach(async () => {
  await runtime?.cleanup();
  runtime = null;
});

describe('saved rule historical replay', () => {
  it('runs the saved rule and returns chart/trigger metadata', async () => {
    runtime = await buildTestRuntime({ market: preparedMarket() });
    const direct = await runTrial({ draft, symbol, windowDays: 1, market: runtime.runtime.market });
    expect(direct.triggers.length).toBeGreaterThanOrEqual(1);
    expect(direct.triggers[0]).toMatchObject({
      triggerMode: 'close',
      markerType: 'trigger',
      truth: true,
    });
    expect(direct.triggers[0].barCloseTime).toBeGreaterThan(direct.triggers[0].barOpenTime);

    const created = await jsonRequest(runtime.runtime, {
      method: 'POST',
      url: '/api/rules',
      payload: { ...draft, enabled: true },
    });
    expect(created.statusCode).toBe(201);
    const id = created.body.rule.id as string;

    const replay = await jsonRequest(runtime.runtime, {
      method: 'POST',
      url: `/api/rules/${id}/trial`,
      payload: { symbol, windowDays: 1 },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.body.symbol).toBe(symbol);
    expect(replay.body.triggers.length).toBe(direct.triggers.length);
    expect(replay.body.triggers[0]).toMatchObject({
      triggerMode: 'close',
      barOpenTime: expect.any(Number),
      barCloseTime: expect.any(Number),
      price: expect.any(Number),
    });
    expect(replay.body.triggers[0].conditions.length).toBe(1);
    expect(replay.body.candles.length).toBeGreaterThan(0);
  });

  it('rejects invalid symbols/windows and unknown rules', async () => {
    runtime = await buildTestRuntime({ market: preparedMarket() });
    const created = await jsonRequest(runtime.runtime, {
      method: 'POST',
      url: '/api/rules',
      payload: { ...draft, enabled: false },
    });
    const id = created.body.rule.id as string;

    const outside = await jsonRequest(runtime.runtime, {
      method: 'POST',
      url: `/api/rules/${id}/trial`,
      payload: { symbol: 'ETH-USDT-SWAP', windowDays: 7 },
    });
    expect(outside.statusCode).toBe(400);

    const badWindow = await jsonRequest(runtime.runtime, {
      method: 'POST',
      url: `/api/rules/${id}/trial`,
      payload: { symbol, windowDays: 31 },
    });
    expect(badWindow.statusCode).toBe(400);

    const missing = await jsonRequest(runtime.runtime, {
      method: 'POST',
      url: '/api/rules/not-found/trial',
      payload: { symbol, windowDays: 7 },
    });
    expect(missing.statusCode).toBe(404);
  });
});
