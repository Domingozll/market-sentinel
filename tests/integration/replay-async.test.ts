import { afterEach, describe, expect, it } from 'vitest';
import { buildTestRuntime, jsonRequest, type TestRuntime } from '../helpers/test-runtime';
import { FakeMarket, makeCandles } from '../helpers/fake-market';

let runtime: TestRuntime | null = null;
afterEach(async () => {
  await runtime?.cleanup();
  runtime = null;
});

const symbol = 'BTC-USDT-SWAP';
const now = Date.parse('2026-11-16T12:00:00Z');

function makeRule() {
  return {
    name: '异步自定义回放',
    symbols: [symbol],
    triggerMode: 'close',
    cooldownSec: 0,
    enabled: false,
    expression: {
      kind: 'group',
      op: 'AND',
      children: [{
        kind: 'condition',
        id: 'always',
        timeframe: '5m',
        left: { series: 'price.close' },
        cmp: 'gte',
        right: { type: 'number', value: 0 },
      }],
    },
  };
}

async function waitForJob(runtime: TestRuntime, id: string): Promise<any> {
  for (let i = 0; i < 80; i++) {
    const res = await jsonRequest(runtime.runtime, { method: 'GET', url: `/api/replay-jobs/${id}` });
    if (res.body.job.status === 'completed' || res.body.job.status === 'failed') return res.body.job;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('replay job did not finish');
}

describe('async custom replay jobs', () => {
  it('creates a persisted job, processes a custom period and stores the result', async () => {
    const market = new FakeMarket(now);
    market.seed(symbol, '5m', makeCandles({ instId: symbol, timeframe: '5m', count: 1000, endCloseTime: now }));
    runtime = await buildTestRuntime({ market });
    const created = await jsonRequest(runtime.runtime, { method: 'POST', url: '/api/rules', payload: makeRule() });
    expect(created.statusCode).toBe(201);
    const ruleId = created.body.rule.id as string;

    const started = await jsonRequest(runtime.runtime, {
      method: 'POST',
      url: `/api/rules/${ruleId}/replays/async`,
      payload: {
        symbol,
        chartTimeframe: '5m',
        period: {
          startDate: '2026-11-15',
          endDate: '2026-11-16',
          timezone: 'UTC',
          allDay: true,
        },
      },
    });
    expect(started.statusCode).toBe(202);
    expect(started.body.job.status).toMatch(/queued|processing/);
    expect(started.body.job.estimatedSeconds).toBeGreaterThan(0);
    const job = await waitForJob(runtime, started.body.job.id);
    expect(job.status).toBe('completed');
    expect(job.replayId).toBeTruthy();

    const replay = await jsonRequest(runtime.runtime, { method: 'GET', url: `/api/replays/${job.replayId}` });
    expect(replay.statusCode).toBe(200);
    expect(replay.body.replay.period).toMatchObject({
      timezone: 'UTC',
      allDay: true,
    });
    expect(replay.body.replay.result.period).toBeTruthy();
    expect(replay.body.replay.result.period.from).toBe(Date.parse('2026-11-15T00:00:00Z'));
    expect(replay.body.replay.result.windowDays).toBeGreaterThan(1);
    expect(replay.body.replay.result.candles.length).toBeGreaterThan(0);
  });
});
