import { describe, expect, it } from 'vitest';
import { FakeMarket, makeCandles } from '../helpers/fake-market';
import { runTrial, TrialError } from '../../src/server/trial';
import { bollingerBands } from '../../src/server/indicators';
import type { ConditionGroup, RuleDraft } from '../../src/shared/types';

const symbol = 'BTC-USDT-SWAP';
const endClose = Date.parse('2026-11-09T16:00:00+08:00');
const tfMs = 300_000;

function makeDraft(overrides: Partial<RuleDraft> = {}): RuleDraft {
  const expression: ConditionGroup = {
    kind: 'group',
    op: 'AND',
    children: [
      {
        kind: 'condition',
        id: 'touch',
        timeframe: '5m',
        left: { series: 'price.low' },
        cmp: 'lte',
        right: { type: 'series', series: 'bb.lower', params: { length: 20, mult: 2 } },
      },
    ],
  };
  return {
    name: '试跑规则',
    symbols: [symbol],
    triggerMode: 'close',
    cooldownSec: 0,
    expression,
    note: '',
    ...overrides,
  };
}

function prepare(touchIndexes: number[], count = 500): { market: FakeMarket; candles: ReturnType<typeof makeCandles> } {
  const candles = makeCandles({ instId: symbol, timeframe: '5m', count, endCloseTime: endClose });
  const bands = bollingerBands(candles, { length: 20, mult: 2 });
  const touchSet = new Set(touchIndexes);
  for (let i = 0; i < candles.length; i++) {
    const lower = bands.lower[i];
    if (lower === null) continue;
    const low = touchSet.has(i) ? lower - 1 : lower + 1;
    candles[i] = { ...candles[i], low, high: Math.max(candles[i].high, low + 0.1) };
  }
  const market = new FakeMarket(endClose + 5000);
  market.setHistory(symbol, '5m', candles);
  return { market, candles };
}

describe('runTrial', () => {
  it('counts exactly the isolated touch closures in the window', async () => {
    const touches = [250, 300, 450];
    const { market, candles } = prepare(touches);
    const result = await runTrial({ draft: makeDraft(), symbol, windowDays: 1, market });
    expect(result.triggerCount).toBe(3);
    expect(result.triggers).toHaveLength(3);
    expect(result.windowDays).toBe(1);
    expect(result.timeframe).toBe('5m');
    const expectedTimes = touches.map((index) => candles[index].openTime + tfMs).sort((a, b) => a - b);
    expect(result.triggers.map((trigger) => trigger.triggerAt)).toEqual(expectedTimes);
    expect(result.candles.length).toBeLessThanOrEqual(480);
    expect(result.indicators.upper.length).toBe(result.candles.length);
  });

  it('does not count a trigger when the cooldown suppresses it', async () => {
    const count = 500;
    const first = 400;
    const second = 403;
    const { market } = prepare([first, second], count);
    const draft = makeDraft({ cooldownSec: 3600 });
    const result = await runTrial({ draft, symbol, windowDays: 1, market });
    expect(result.triggerCount).toBe(1);
  });

  it('baselines an already-satisfied condition at the window start', async () => {
    const touches = [240, 241, 242, 243, 244];
    const { market, candles } = prepare(touches);
    const result = await runTrial({ draft: makeDraft({ cooldownSec: 0 }), symbol, windowDays: 1, market });
    // The five consecutive true bars form one edge, so only one notification is correct.
    expect(result.triggerCount).toBe(1);
    expect(candles.length).toBe(500);
  });

  it('warns that intrabar history is simulated as close-confirmed', async () => {
    const { market } = prepare([400]);
    const result = await runTrial({ draft: makeDraft({ triggerMode: 'intrabar' }), symbol, windowDays: 1, market });
    expect(result.warning).toContain('盘中');
  });

  it('rejects an unsupported symbol and insufficient history', async () => {
    const { market } = prepare([400]);
    await expect(runTrial({ draft: makeDraft(), symbol: 'ETH-USDT-SWAP', windowDays: 1, market })).rejects.toBeInstanceOf(TrialError);
    market.setHistory(symbol, '5m', []);
    await expect(runTrial({ draft: makeDraft(), symbol, windowDays: 1, market })).rejects.toThrow(/历史数据不足/);
  });

  it('clamps a 1m rule to the seven-day trial limit', async () => {
    const market = new FakeMarket(endClose + 5000);
    const candles = makeCandles({ instId: symbol, timeframe: '1m', count: 1200, endCloseTime: endClose });
    market.setHistory(symbol, '1m', candles);
    const expression: ConditionGroup = {
      kind: 'group',
      op: 'AND',
      children: [
        {
          kind: 'condition',
          id: 'c1',
          timeframe: '1m',
          left: { series: 'price.low' },
          cmp: 'lte',
          right: { type: 'number', value: 0 },
        },
      ],
    };
    const result = await runTrial({
      draft: makeDraft({ expression }),
      symbol,
      windowDays: 30,
      market,
    });
    expect(result.windowDays).toBe(7);
    expect(result.warning).toContain('最多试跑 7 天');
  });
});
