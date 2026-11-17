import { describe, expect, it } from 'vitest';
import { computeBbTurnSignals, type BbTurnCandleLike } from '../../src/shared/bbTurn';
import { computeSeries } from '../../src/shared/indicators';
import { parseRuleInput } from '../../src/server/rules/schema';
import { ruleSummary } from '../../src/server/rules/summary';

function countOnes(values: Array<number | null>): number {
  return values.reduce<number>((sum, value) => sum + (value === 1 ? 1 : 0), 0);
}

function trendCandles(n = 1800): BbTurnCandleLike[] {
  let seed = 1;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32 - 0.5;
  };
  let price = 100;
  const candles: BbTurnCandleLike[] = [];
  for (let i = 0; i < n; i++) {
    const drift = i < 500 ? 0.0018 : i < 900 ? -0.0018 : i < 1400 ? 0.0018 : -0.0018;
    price *= Math.exp(drift + random() * 0.0005);
    candles.push({ close: price, confirm: true });
  }
  return candles;
}

function ruleWithTurn() {
  return {
    name: '中线拐点规则',
    symbols: ['BTC-USDT-SWAP'],
    triggerMode: 'close',
    cooldownSec: 300,
    expression: {
      kind: 'group',
      op: 'AND',
      children: [{
        kind: 'condition',
        id: 'c1',
        timeframe: '5m',
        left: { series: 'bbTurn.warnTop', params: { length: 20, mDec: 12, zOn: 1, zWindow: 200 } },
        cmp: 'gte',
        right: { type: 'number', value: 1 },
      }],
    },
  };
}

describe('BB midline turn detector', () => {
  it('detects a top warning and confirms both directions on a deterministic trend', () => {
    const signals = computeBbTurnSignals(trendCandles());
    expect(signals.warnTop.length).toBe(1800);
    expect(countOnes(signals.warnTop)).toBeGreaterThan(0);
    expect(countOnes(signals.confirmTop)).toBeGreaterThan(0);
    expect(countOnes(signals.confirmBottom)).toBeGreaterThan(0);
  });

  it('does not emit signals for a forming candle and keeps the prefix causal', () => {
    const candles = trendCandles();
    const full = computeBbTurnSignals(candles);
    const cut = 1200;
    const prefix = computeBbTurnSignals(candles.slice(0, cut));
    for (const key of ['warnTop', 'warnBottom', 'confirmTop', 'confirmBottom'] as const) {
      expect(prefix[key].slice(0, cut)).toEqual(full[key].slice(0, cut));
    }
    const withForming = computeBbTurnSignals([...candles, { close: 1, confirm: false }]);
    expect(withForming.warnTop.at(-1)).toBe(0);
    expect(withForming.warnBottom.at(-1)).toBe(0);
    expect(withForming.confirmTop.at(-1)).toBe(0);
    expect(withForming.confirmBottom.at(-1)).toBe(0);
  });

  it('is exposed as four computable rule series', () => {
    const candles = trendCandles(300).map((candle, index) => ({
      open: candle.close,
      high: candle.close,
      low: candle.close,
      close: candle.close,
      volume: 1,
      confirm: index < 299,
    }));
    for (const series of ['bbTurn.warnTop', 'bbTurn.warnBottom', 'bbTurn.confirmTop', 'bbTurn.confirmBottom'] as const) {
      expect(computeSeries(candles, series, { length: 20, mDec: 12, zOn: 1, zWindow: 120 })).toHaveLength(300);
    }
  });

  it('validates parameters and accepts the signal condition in a rule', () => {
    const parsed = parseRuleInput(ruleWithTurn());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(ruleSummary(parsed.value.draft.expression)).toContain('中线见顶预警');
    const invalid = parseRuleInput({
      ...ruleWithTurn(),
      expression: {
        kind: 'group',
        op: 'AND',
        children: [{
          kind: 'condition',
          id: 'c1',
          timeframe: '5m',
          left: { series: 'bbTurn.warnTop', params: { zWindow: 50 } },
          cmp: 'gte',
          right: { type: 'number', value: 1 },
        }],
      },
    });
    expect(invalid.ok).toBe(false);

    const intrabar = parseRuleInput({ ...ruleWithTurn(), triggerMode: 'intrabar' });
    expect(intrabar.ok).toBe(true);
    if (intrabar.ok) {
      expect(intrabar.value.warnings.some((warning) => warning.code === 'bbturn.intrabar')).toBe(true);
    }
  });
});
