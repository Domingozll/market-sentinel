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
  market.setHistory(symbol, '15m', makeCandles({ instId: symbol, timeframe: '15m', count: 500, endCloseTime: endClose }));
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

  it('persists each run and returns it without re-running the trial', async () => {
    runtime = await buildTestRuntime({ market: preparedMarket() });
    const created = await jsonRequest(runtime.runtime, {
      method: 'POST',
      url: '/api/rules',
      payload: { ...draft, enabled: true },
    });
    const id = created.body.rule.id as string;

    const run = await jsonRequest(runtime.runtime, {
      method: 'POST',
      url: `/api/rules/${id}/replays`,
      payload: { symbol, windowDays: 1, chartTimeframe: '15m' },
    });
    expect(run.statusCode).toBe(201);
    expect(run.body.replay.result).toMatchObject({
      symbol,
      timeframe: '15m',
      signalTimeframe: '5m',
      windowDays: 1,
    });
    expect(run.body.replay.result.data.source).toMatch(/local|remote/);
    expect(run.body.replay.ruleVersion).toBe(1);

    const listed = await jsonRequest(runtime.runtime, { method: 'GET', url: `/api/rules/${id}/replays` });
    expect(listed.statusCode).toBe(200);
    expect(listed.body.replays).toHaveLength(1);
    expect(listed.body.replays[0]).toMatchObject({
      id: run.body.replay.id,
      symbol,
      chartTimeframe: '15m',
      signalTimeframe: '5m',
    });

    const saved = await jsonRequest(runtime.runtime, { method: 'GET', url: `/api/replays/${run.body.replay.id}` });
    expect(saved.statusCode).toBe(200);
    expect(saved.body.replay.result.triggers.length).toBe(run.body.replay.result.triggers.length);
    expect(saved.body.replay.result.candles.length).toBe(run.body.replay.result.candles.length);

    const listedAgain = await jsonRequest(runtime.runtime, { method: 'GET', url: `/api/rules/${id}/replays` });
    expect(listedAgain.body.replays).toHaveLength(1);

    const chartCandles = await jsonRequest(runtime.runtime, {
      method: 'GET',
      url: `/api/replays/${run.body.replay.id}/chart-candles?timeframe=5m`,
    });
    expect(chartCandles.statusCode).toBe(200);
    expect(chartCandles.body.timeframe).toBe('5m');
    expect(chartCandles.body.candles.length).toBeGreaterThan(0);
    expect(chartCandles.body.data.source).toMatch(/local|remote/);

    const badTimeframe = await jsonRequest(runtime.runtime, {
      method: 'GET',
      url: `/api/replays/${run.body.replay.id}/chart-candles?timeframe=bad`,
    });
    expect(badTimeframe.statusCode).toBe(400);
  });

  it('creates a fresh replay after the rule version changes and keeps the old snapshot', async () => {
    runtime = await buildTestRuntime({ market: preparedMarket() });
    const created = await jsonRequest(runtime.runtime, {
      method: 'POST',
      url: '/api/rules',
      payload: { ...draft, name: '版本回放 v1', enabled: true },
    });
    const id = created.body.rule.id as string;
    const first = await jsonRequest(runtime.runtime, {
      method: 'POST',
      url: `/api/rules/${id}/replays`,
      payload: { symbol, windowDays: 1, chartTimeframe: '5m' },
    });
    expect(first.statusCode).toBe(201);
    expect(first.body.replay.ruleVersion).toBe(1);
    expect(first.body.replay.result.triggerCount).toBeGreaterThan(0);

    const updated = await jsonRequest(runtime.runtime, {
      method: 'PUT',
      url: `/api/rules/${id}`,
      payload: {
        ...draft,
        name: '版本回放 v2',
        cooldownSec: 3600,
        enabled: true,
        expression: {
          kind: 'group',
          op: 'AND',
          children: [{
            kind: 'condition',
            id: 'never',
            timeframe: '5m',
            left: { series: 'price.close' },
            cmp: 'gte',
            right: { type: 'number', value: 999_999 },
          }],
        },
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.body.rule.version).toBe(2);

    const second = await jsonRequest(runtime.runtime, {
      method: 'POST',
      url: `/api/rules/${id}/replays`,
      payload: { symbol, windowDays: 1, chartTimeframe: '5m' },
    });
    expect(second.statusCode).toBe(201);
    expect(second.body.replay.ruleVersion).toBe(2);
    expect(second.body.replay.result.triggerCount).toBe(0);

    const list = await jsonRequest(runtime.runtime, { method: 'GET', url: `/api/rules/${id}/replays` });
    expect(list.body.replays).toHaveLength(2);
    expect(list.body.replays[0].ruleVersion).toBe(2);
    expect(list.body.replays[1].ruleVersion).toBe(1);

    const old = await jsonRequest(runtime.runtime, { method: 'GET', url: `/api/replays/${first.body.replay.id}` });
    expect(old.statusCode).toBe(200);
    expect(old.body.replay.ruleVersion).toBe(1);
    expect(old.body.replay.result.triggerCount).toBeGreaterThan(0);
  });

  it('calculates single and batch position PnL from signal-timeframe candles', async () => {
    runtime = await buildTestRuntime({ market: preparedMarket() });
    const created = await jsonRequest(runtime.runtime, {
      method: 'POST',
      url: '/api/rules',
      payload: { ...draft, enabled: true },
    });
    const id = created.body.rule.id as string;
    const run = await jsonRequest(runtime.runtime, {
      method: 'POST',
      url: `/api/rules/${id}/replays`,
      payload: { symbol, windowDays: 1, chartTimeframe: '5m' },
    });
    expect(run.statusCode).toBe(201);
    expect(run.body.replay.result.triggers.length).toBeGreaterThan(1);

    const config = {
      direction: 'long',
      capital: 1_000,
      leverage: 5,
      feeRatePct: 0.05,
      slippagePct: 0.02,
      target: { mode: 'percent', percent: 1 },
      stop: { mode: 'percent', percent: 1 },
    };
    const one = await jsonRequest(runtime.runtime, {
      method: 'POST',
      url: `/api/replays/${run.body.replay.id}/position-calc`,
      payload: { config, triggerIndexes: [0] },
    });
    expect(one.statusCode).toBe(200);
    expect(one.body.calculation.trades).toHaveLength(1);
    expect(one.body.calculation.trades[0].entryPrice).toBeGreaterThan(0);
    expect(Number.isFinite(one.body.calculation.trades[0].netPnl)).toBe(true);
    expect(one.body.calculation.trades[0].equityBefore).toBe(1_000);
    expect(one.body.calculation.trades[0]).toMatchObject({
      symbol,
      direction: 'long',
      leverage: 5,
      marginMode: 'isolated',
      initialMargin: 1_000,
      maintenanceMargin: null,
      fundingFee: null,
    });
    expect(one.body.calculation.trades[0].entryAt).toBeGreaterThan(0);
    expect(one.body.calculation.trades[0].exitAt).toBeGreaterThanOrEqual(one.body.calculation.trades[0].entryAt);
    expect(one.body.calculation.trades[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(one.body.calculation.trades[0].openFee + one.body.calculation.trades[0].closeFee)
      .toBeCloseTo(one.body.calculation.trades[0].fees, 8);

    const batch = await jsonRequest(runtime.runtime, {
      method: 'POST',
      url: `/api/replays/${run.body.replay.id}/position-calc`,
      payload: { config, triggerIndexes: [0, 1, 2] },
    });
    expect(batch.statusCode).toBe(200);
    expect(batch.body.calculation.trades.length + batch.body.calculation.skipped.length).toBe(3);
    expect(batch.body.calculation.finalEquity).toBeGreaterThanOrEqual(0);

    const indicator = await jsonRequest(runtime.runtime, {
      method: 'POST',
      url: `/api/replays/${run.body.replay.id}/position-calc`,
      payload: {
        config: {
          ...config,
          target: { mode: 'indicator', series: 'bb.upper' },
          stop: { mode: 'none' },
        },
        triggerIndexes: [0],
      },
    });
    expect(indicator.statusCode).toBe(200);
    expect(indicator.body.calculation.trades[0].targetPrice).not.toBeNull();

    const bad = await jsonRequest(runtime.runtime, {
      method: 'POST',
      url: `/api/replays/${run.body.replay.id}/position-calc`,
      payload: { config, triggerIndexes: [999] },
    });
    expect(bad.statusCode).toBe(400);
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
