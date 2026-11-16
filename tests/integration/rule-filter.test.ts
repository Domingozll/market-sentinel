import { afterEach, describe, expect, it } from 'vitest';
import { buildTestRuntime, jsonRequest, type TestRuntime } from '../helpers/test-runtime';

let runtime: TestRuntime | null = null;
afterEach(async () => {
  await runtime?.cleanup();
  runtime = null;
});

function payload(overrides: Record<string, unknown> = {}) {
  return {
    name: '过滤与负数阈值',
    symbols: ['BTC-USDT-SWAP'],
    triggerMode: 'close',
    cooldownSec: 0,
    enabled: false,
    skipUsNonTradingDays: true,
    expression: {
      kind: 'group',
      op: 'AND',
      children: [{
        kind: 'condition',
        id: 'negative',
        timeframe: '5m',
        left: { series: 'kdj.j' },
        cmp: 'lte',
        right: { type: 'number', value: -1.25 },
      }],
    },
    ...overrides,
  };
}

describe('rule US-market filter and fixed values', () => {
  it('persists negative decimal thresholds and the filter flag', async () => {
    runtime = await buildTestRuntime();
    const created = await jsonRequest(runtime.runtime, { method: 'POST', url: '/api/rules', payload: payload() });
    expect(created.statusCode).toBe(201);
    expect(created.body.rule.skipUsNonTradingDays).toBe(true);
    const rule = created.body.rule;
    expect(rule.expression.children[0].right).toEqual({ type: 'number', value: -1.25 });

    const fetched = await jsonRequest(runtime.runtime, { method: 'GET', url: `/api/rules/${rule.id}` });
    expect(fetched.body.rule.skipUsNonTradingDays).toBe(true);
    expect(fetched.body.rule.expression.children[0].right.value).toBe(-1.25);

    const updated = await jsonRequest(runtime.runtime, {
      method: 'PUT',
      url: `/api/rules/${rule.id}`,
      payload: payload({ name: '过滤关闭', skipUsNonTradingDays: false }),
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.body.rule.skipUsNonTradingDays).toBe(false);
    expect(updated.body.rule.version).toBe(2);
  });

  it('rejects a non-boolean filter value', async () => {
    runtime = await buildTestRuntime();
    const created = await jsonRequest(runtime.runtime, {
      method: 'POST',
      url: '/api/rules',
      payload: payload({ skipUsNonTradingDays: 'true' }),
    });
    expect(created.statusCode).toBe(400);
  });
});
