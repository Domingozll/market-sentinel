import { describe, expect, it } from 'vitest';
import { FakeMarket, makeCandles } from '../helpers/fake-market';
import { runTrial, TrialError } from '../../src/server/trial';
import { bollingerBands } from '../../src/server/indicators';
import type { ConditionGroup, ReplayPeriod, RuleDraft } from '../../src/shared/types';

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

  it('filters historical triggers on US non-trading days', async () => {
    const symbol = 'BTC-USDT-SWAP';
    const holidayClose = Date.parse('2025-01-01T17:00:00Z'); // 12:00 America/New_York, New Year
    const tf = '5m' as const;
    const candles = makeCandles({ instId: symbol, timeframe: tf, count: 400, endCloseTime: holidayClose });
    // A clean false -> true edge on the holiday close.
    for (let i = 0; i < candles.length; i++) {
      const isHolidayEdge = i === candles.length - 1;
      const close = isHolidayEdge ? 110 : 90;
      candles[i] = {
        ...candles[i],
        open: close,
        high: close + 0.5,
        low: close - 0.5,
        close,
      };
    }
    const market = new FakeMarket(holidayClose + 5000);
    market.setHistory(symbol, tf, candles);
    const expression: ConditionGroup = {
      kind: 'group',
      op: 'AND',
      children: [{
        kind: 'condition',
        id: 'edge',
        timeframe: tf,
        left: { series: 'price.close' },
        cmp: 'gte',
        right: { type: 'number', value: 100 },
      }],
    };
    const draft = makeDraft({ expression, cooldownSec: 0 });
    const unfiltered = await runTrial({ draft, symbol, windowDays: 1, market });
    expect(unfiltered.triggerCount).toBe(1);
    const filtered = await runTrial({
      draft: { ...draft, skipUsNonTradingDays: true },
      symbol,
      windowDays: 1,
      market,
    });
    expect(filtered.triggerCount).toBe(0);
    expect(filtered.warning).toContain('已过滤美股非交易日');
  });

  it('limits custom triggers to the daily window while keeping state current', async () => {
    const symbol = 'BTC-USDT-SWAP';
    const now = Date.parse('2026-11-16T12:00:00Z');
    const tf = '5m' as const;
    const candles = makeCandles({ instId: symbol, timeframe: tf, count: 1000, endCloseTime: now });
    const highFrom = Date.parse('2026-11-16T08:00:00Z');
    for (let i = 0; i < candles.length; i++) {
      if (candles[i].openTime >= highFrom) {
        candles[i] = { ...candles[i], open: 90, high: 111, low: 89, close: 110 };
      } else {
        candles[i] = { ...candles[i], open: 90, high: 91, low: 89, close: 90 };
      }
    }
    const market = new FakeMarket(now);
    market.setHistory(symbol, tf, candles);
    const expression: ConditionGroup = {
      kind: 'group',
      op: 'AND',
      children: [{
        kind: 'condition',
        id: 'high',
        timeframe: tf,
        left: { series: 'price.close' },
        cmp: 'gte',
        right: { type: 'number', value: 100 },
      }],
    };
    const base = { ...makeDraft({ expression }), cooldownSec: 0 };
    const allDay: ReplayPeriod = {
      from: Date.parse('2026-11-15T00:00:00Z'),
      to: now,
      timezone: 'UTC',
      dailyStartMinute: 0,
      dailyEndMinute: 1440,
      allDay: true,
    };
    const session: ReplayPeriod = { ...allDay, allDay: false, dailyStartMinute: 9 * 60, dailyEndMinute: 10 * 60 };
    const unfiltered = await runTrial({ draft: base, symbol, windowDays: 1, market, now, period: allDay });
    expect(unfiltered.triggerCount).toBe(1);
    const filtered = await runTrial({ draft: base, symbol, windowDays: 1, market, now, period: session });
    expect(filtered.triggerCount).toBe(0);
    expect(filtered.warning).toContain('信号仅在所选时段内生成');
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

    const extended = await runTrial({
      draft: makeDraft({ expression }),
      symbol,
      windowDays: 30,
      market,
      allowExtendedWindow: true,
    });
    expect(extended.windowDays).toBe(30);
    expect(extended.warning).not.toContain('最多试跑 7 天');
  });
});
