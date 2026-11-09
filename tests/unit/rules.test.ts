import { describe, expect, it } from 'vitest';
import {
  parseRuleInput,
  evaluateExpression,
  flattenConditions,
  collectTimeframes,
} from '../../src/server/rules/schema';
import { ruleSummary } from '../../src/server/rules/summary';
import { evaluateRule } from '../../src/server/rules/evaluator';
import { FakeMarket, makeCandles } from '../helpers/fake-market';
import type { Rule } from '../../src/shared/types';
import { bollingerBands } from '../../src/server/indicators';

const tf = '5m' as const;
const endClose = Date.parse('2026-11-09T15:00:00+08:00');

function condition(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'condition',
    id: 'c1',
    timeframe: '5m',
    left: { series: 'price.low' },
    cmp: 'lte',
    right: { type: 'series', series: 'bb.lower', params: { length: 20, mult: 2 } },
    ...overrides,
  };
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    name: '测试规则',
    symbols: ['BTC-USDT-SWAP'],
    triggerMode: 'close',
    cooldownSec: 300,
    expression: { kind: 'group', op: 'AND', children: [condition()] },
    ...overrides,
  };
}

function asRule(raw: Record<string, unknown>): Rule {
  const parsed = parseRuleInput(raw);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return {
    ...parsed.value.draft,
    id: 'r1',
    enabled: true,
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
  };
}

function seedTouchMarket(): { market: FakeMarket; symbol: string; lastClose: number; lower: number } {
  const symbol = 'BTC-USDT-SWAP';
  const market = new FakeMarket(endClose + 5000);
  const candles = makeCandles({ instId: symbol, timeframe: tf, count: 260, endCloseTime: endClose });
  const bands = bollingerBands(candles, { length: 20, mult: 2 });
  const lower = bands.lower.at(-1) as number;
  candles[candles.length - 1] = {
    ...candles[candles.length - 1],
    low: lower - 2,
    high: Math.max(candles[candles.length - 1].high, lower),
  };
  market.seed(symbol, tf, candles);
  return { market, symbol, lastClose: endClose, lower };
}

describe('rule schema and summary', () => {
  it('normalizes a valid rule and builds a natural-language summary', () => {
    const parsed = parseRuleInput(draft());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.draft.symbols).toEqual(['BTC-USDT-SWAP']);
    expect(parsed.value.draft.expression.kind).toBe('group');
    expect(flattenConditions(parsed.value.draft.expression)).toHaveLength(1);
    expect(collectTimeframes(parsed.value.draft.expression)).toEqual(['5m']);
    const summary = ruleSummary(parsed.value.draft.expression);
    expect(summary).toContain('5m 最低价');
    expect(summary).toContain('布林带下轨');
  });

  it('accepts a nested AND/OR expression and warns on unit mismatch', () => {
    const parsed = parseRuleInput(
      draft({
        expression: {
          kind: 'group',
          op: 'AND',
          children: [
            condition({ id: 'c1' }),
            {
              kind: 'group',
              op: 'OR',
              children: [
                condition({ id: 'c2', left: { series: 'price.high' }, cmp: 'gte', right: { type: 'series', series: 'bb.upper' } }),
                condition({ id: 'c3', left: { series: 'volume.quote' }, cmp: 'gte', right: { type: 'number', value: 1000 } }),
              ],
            },
          ],
        },
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(flattenConditions(parsed.value.draft.expression)).toHaveLength(3);
  });

  it('rejects invalid structure and parameters', () => {
    const badName = parseRuleInput(draft({ name: 'x' }));
    expect(badName.ok).toBe(false);
    const badSymbols = parseRuleInput(draft({ symbols: [] }));
    expect(badSymbols.ok).toBe(false);
    const badSeries = parseRuleInput(draft({ expression: condition({ left: { series: 'nope' } }) }));
    expect(badSeries.ok).toBe(false);
    const badCmp = parseRuleInput(draft({ expression: condition({ cmp: 'eq' }) }));
    expect(badCmp.ok).toBe(false);
    const badDepth = parseRuleInput(
      draft({
        expression: {
          kind: 'group', op: 'AND', children: [
            { kind: 'group', op: 'AND', children: [
              { kind: 'group', op: 'AND', children: [
                { kind: 'group', op: 'AND', children: [condition()] },
              ] },
            ] },
          ],
        },
      }),
    );
    expect(badDepth.ok).toBe(false);
    const badParams = parseRuleInput(
      draft({ expression: condition({ left: { series: 'bb.midSlope', params: { length: 1, slopeWindow: 0 } } }) }),
    );
    expect(badParams.ok).toBe(false);
  });

  it('rejects more than 12 conditions', () => {
    const children = Array.from({ length: 13 }, (_, index) => condition({ id: `c${index}` }));
    const parsed = parseRuleInput(draft({ expression: { kind: 'group', op: 'AND', children } }));
    expect(parsed.ok).toBe(false);
  });

  it('evaluates boolean trees', () => {
    const expr = {
      kind: 'group' as const,
      op: 'OR' as const,
      children: [
        { kind: 'condition' as const, id: 'a', timeframe: '5m' as const, left: { series: 'price.close' as const }, cmp: 'gt' as const, right: { type: 'number' as const, value: 1 } },
        { kind: 'condition' as const, id: 'b', timeframe: '5m' as const, left: { series: 'price.close' as const }, cmp: 'lt' as const, right: { type: 'number' as const, value: 0 } },
      ],
    };
    expect(evaluateExpression(expr, new Map([['a', false], ['b', true]]))).toBe(true);
    expect(evaluateExpression(expr, new Map([['a', false], ['b', false]]))).toBe(false);
  });
});

describe('rule evaluator', () => {
  it('evaluates a price/lower-band condition on the latest closed bar', () => {
    const { market, symbol } = seedTouchMarket();
    const rule = asRule(draft());
    const outcome = evaluateRule(rule, symbol, market, market.exchangeNow());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.evaluation.truth).toBe(true);
    expect(outcome.evaluation.referenceTimeframe).toBe('5m');
    expect(outcome.evaluation.conditions[0].rightSeries).toBe('bb.lower');
    expect(outcome.evaluation.conditions[0].leftValue).toBeLessThan(outcome.evaluation.conditions[0].rightValue!);
  });

  it('returns stale when the last closed bar is outside the expected boundary', () => {
    const { market, symbol } = seedTouchMarket();
    market.setNow(endClose + 11 * 60_000);
    const outcome = evaluateRule(asRule(draft()), symbol, market, market.exchangeNow());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('stale');
  });

  it('returns gap when history is missing a bar', () => {
    const symbol = 'BTC-USDT-SWAP';
    const market = new FakeMarket(endClose + 5000);
    const candles = makeCandles({ instId: symbol, timeframe: '5m', count: 260, endCloseTime: endClose });
    candles.splice(candles.length - 100, 1);
    market.seed(symbol, '5m', candles);
    const outcome = evaluateRule(asRule(draft()), symbol, market, market.exchangeNow());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('gap');
  });

  it('aligns 15m and 5m conditions at the same evaluation point', () => {
    const symbol = 'BTC-USDT-SWAP';
    const market = new FakeMarket(endClose + 5000);
    const five = makeCandles({ instId: symbol, timeframe: '5m', count: 300, endCloseTime: endClose });
    const fifteen = makeCandles({ instId: symbol, timeframe: '15m', count: 260, endCloseTime: endClose });
    const risingBase = fifteen[fifteen.length - 22].close;
    for (let i = fifteen.length - 21; i < fifteen.length; i++) {
      const close = risingBase + (i - (fifteen.length - 21)) * 1.5;
      const previous = fifteen[i - 1];
      fifteen[i] = {
        ...fifteen[i],
        open: previous.close,
        close,
        high: Math.max(previous.close, close) + 0.2,
        low: Math.min(previous.close, close) - 0.2,
      };
    }
    const bands = bollingerBands(five, { length: 20, mult: 2 });
    five[five.length - 1] = {
      ...five[five.length - 1],
      low: (bands.lower.at(-1) as number) - 2,
    };
    market.seed(symbol, '5m', five);
    market.seed(symbol, '15m', fifteen);
    const rule = asRule(
      draft({
        expression: {
          kind: 'group', op: 'AND', children: [
            condition({ id: 'trend', timeframe: '15m', left: { series: 'bb.midSlope', params: { length: 20, mult: 2, slopeWindow: 1 } }, cmp: 'gt', right: { type: 'number', value: 0 } }),
            condition({ id: 'touch', timeframe: '5m' }),
          ],
        },
      }),
    );
    const outcome = evaluateRule(rule, symbol, market, market.exchangeNow());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.evaluation.truth).toBe(true);
    expect(outcome.evaluation.conditions).toHaveLength(2);
    expect(new Set(outcome.evaluation.conditions.map((c) => c.timeframe))).toEqual(new Set(['5m', '15m']));
  });

  it('uses the forming bar in intrabar mode and closed bars in close mode', () => {
    const symbol = 'BTC-USDT-SWAP';
    const market = new FakeMarket(endClose + 5000);
    const five = makeCandles({ instId: symbol, timeframe: '5m', count: 260, endCloseTime: endClose });
    const bands = bollingerBands(five, { length: 20, mult: 2 });
    market.seed(symbol, '5m', five);
    const lastClose = five.at(-1)!.close;
    const forming = {
      ...five.at(-1)!,
      openTime: endClose,
      open: lastClose,
      high: lastClose + 1,
      low: (bands.lower.at(-1) as number) - 3,
      close: lastClose,
      confirm: false,
    };
    market.setNow(endClose + 2 * 60_000);
    market.pushTick(forming);
    const closeRule = asRule(draft({ triggerMode: 'close' }));
    const intrabarRule = asRule(draft({ triggerMode: 'intrabar' }));
    expect((evaluateRule(closeRule, symbol, market, market.exchangeNow()) as any).evaluation.truth).toBe(false);
    expect((evaluateRule(intrabarRule, symbol, market, market.exchangeNow()) as any).evaluation.truth).toBe(true);
    const forcedClosed = evaluateRule(intrabarRule, symbol, market, market.exchangeNow(), true);
    expect(forcedClosed.ok).toBe(true);
    if (forcedClosed.ok) expect(forcedClosed.evaluation.truth).toBe(false);
  });
});
