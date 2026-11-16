import { describe, expect, it } from 'vitest';
import {
  calculatePositions,
  PositionCalcError,
} from '../../src/server/positionCalculator';
import type {
  Candle,
  PositionCalculatorConfig,
  TrialTrigger,
} from '../../src/shared/types';

const tfMs = 300_000;

function candle(openTime: number, open: number, high: number, low: number, close: number): Candle {
  return {
    instId: 'BTC-USDT-SWAP',
    timeframe: '5m',
    openTime,
    open,
    high,
    low,
    close,
    volume: 100,
    vol: 10,
    volCcy: 10,
    volCcyQuote: 100,
    confirm: true,
  };
}

function trigger(overrides: Partial<TrialTrigger> = {}): TrialTrigger {
  return {
    triggerAt: 300_000,
    barOpenTime: 0,
    barCloseTime: 300_000,
    price: 100,
    triggerMode: 'close',
    conditions: [],
    truth: true,
    alreadyMatched: false,
    markerType: 'trigger',
    ...overrides,
  };
}

function config(overrides: Partial<PositionCalculatorConfig> = {}): PositionCalculatorConfig {
  return {
    direction: 'long',
    capital: 1_000,
    leverage: 5,
    feeRatePct: 0.05,
    slippagePct: 0,
    target: { mode: 'price', price: 110 },
    stop: { mode: 'price', price: 90 },
    ...overrides,
  };
}

describe('position calculator', () => {
  it('computes exact linear PnL, fees and risk/reward for a long', () => {
    const candles = [candle(300_000, 100, 115, 95, 108)];
    const result = calculatePositions({
      triggers: [trigger()],
      triggerIndexes: [0],
      candles,
      timeframeMs: tfMs,
      endTime: 900_000,
      config: config(),
    });
    const trade = result.trades[0];
    expect(trade.quantity).toBe(50);
    expect(trade.entryPrice).toBe(100);
    expect(trade.exitPrice).toBe(110);
    expect(trade.exitReason).toBe('target');
    expect(trade.grossPnl).toBeCloseTo(500, 8);
    expect(trade.openFee + trade.closeFee).toBeCloseTo(trade.fees, 8);
    expect(trade.fees).toBeCloseTo(5.25, 8);
    expect(trade.netPnl).toBeCloseTo(494.75, 8);
    expect(trade.roiPct).toBeCloseTo(49.475, 8);
    expect(trade.pnlOnNotionalPct).toBeCloseTo((494.75 / 5000) * 100, 8);
    expect(trade.initialMargin).toBe(1000);
    expect(trade.durationMs).toBe(300_000);
    expect(trade.maintenanceMargin).toBeNull();
    expect(trade.fundingFee).toBeNull();
    expect(trade.riskReward).toBeCloseTo(494.75 / 504.75, 8);
    expect(result.finalEquity).toBeCloseTo(1494.75, 8);
  });

  it('computes short PnL and applies exit slippage symmetrically', () => {
    const candles = [candle(300_000, 100, 105, 85, 90)];
    const result = calculatePositions({
      triggers: [trigger()],
      triggerIndexes: [0],
      candles,
      timeframeMs: tfMs,
      endTime: 900_000,
      config: config({ direction: 'short', target: { mode: 'price', price: 90 }, stop: { mode: 'price', price: 110 } }),
    });
    const trade = result.trades[0];
    expect(trade.exitReason).toBe('target');
    expect(trade.exitPrice).toBe(90);
    expect(trade.grossPnl).toBeCloseTo(500, 8);
    expect(trade.fees).toBeCloseTo(4.75, 8);
    expect(trade.netPnl).toBeCloseTo(495.25, 8);
  });

  it('derives percent targets and stops on the correct side for both directions', () => {
    const long = calculatePositions({
      triggers: [trigger()],
      triggerIndexes: [0],
      candles: [candle(300_000, 100, 112, 98, 108)],
      timeframeMs: tfMs,
      endTime: 900_000,
      config: config({ target: { mode: 'percent', percent: 10 }, stop: { mode: 'percent', percent: 10 } }),
    }).trades[0];
    expect(long.targetPrice).toBeCloseTo(110, 8);
    expect(long.stopPrice).toBeCloseTo(90, 8);
    expect(long.exitReason).toBe('target');

    const short = calculatePositions({
      triggers: [trigger()],
      triggerIndexes: [0],
      candles: [candle(300_000, 100, 102, 88, 92)],
      timeframeMs: tfMs,
      endTime: 900_000,
      config: config({ direction: 'short', target: { mode: 'percent', percent: 10 }, stop: { mode: 'percent', percent: 10 } }),
    }).trades[0];
    expect(short.targetPrice).toBeCloseTo(90, 8);
    expect(short.stopPrice).toBeCloseTo(110, 8);
    expect(short.exitReason).toBe('target');
  });

  it('uses a conservative stop-first fill when both levels are inside one candle', () => {
    const candles = [candle(300_000, 100, 115, 85, 100)];
    const result = calculatePositions({
      triggers: [trigger()],
      triggerIndexes: [0],
      candles,
      timeframeMs: tfMs,
      endTime: 900_000,
      config: config(),
    });
    const trade = result.trades[0];
    expect(trade.exitReason).toBe('stop');
    expect(trade.exitPrice).toBe(90);
    expect(trade.netPnl).toBeCloseTo(-504.75, 8);
  });

  it('honors gap fills and exits at the end when neither level is touched', () => {
    const gap = calculatePositions({
      triggers: [trigger()],
      triggerIndexes: [0],
      candles: [candle(300_000, 80, 82, 78, 81)],
      timeframeMs: tfMs,
      endTime: 900_000,
      config: config(),
    }).trades[0];
    expect(gap.exitReason).toBe('stop');
    expect(gap.exitPrice).toBe(80);
    expect(gap.netPnl).toBeCloseTo(-1_000, 8);

    const end = calculatePositions({
      triggers: [trigger()],
      triggerIndexes: [0],
      candles: [candle(300_000, 100, 102, 98, 101)],
      timeframeMs: tfMs,
      endTime: 900_000,
      config: config({ target: { mode: 'none' }, stop: { mode: 'none' } }),
    }).trades[0];
    expect(end.exitReason).toBe('end');
    expect(end.exitPrice).toBe(101);
    expect(end.grossPnl).toBeCloseTo(50, 8);
  });

  it('skips signals that arrive while the current position is still open', () => {
    const candles = [
      candle(300_000, 100, 102, 98, 100),
      candle(600_000, 100, 102, 98, 100),
      candle(900_000, 100, 102, 98, 100),
    ];
    const result = calculatePositions({
      triggers: [
        trigger(),
        trigger({ triggerAt: 450_000, barOpenTime: 300_000, barCloseTime: 450_000 }),
        trigger({ triggerAt: 900_000, barOpenTime: 600_000, barCloseTime: 900_000 }),
      ],
      triggerIndexes: [0, 1, 2],
      candles,
      timeframeMs: tfMs,
      endTime: 1_500_000,
      config: config({ target: { mode: 'none' }, stop: { mode: 'none' } }),
    });
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitReason).toBe('end');
    expect(result.skipped).toEqual([
      { index: 1, triggerAt: 450_000, reason: 'overlap' },
      { index: 2, triggerAt: 900_000, reason: 'overlap' },
    ]);
    expect(result.warnings.join(' ')).toContain('尚未退出而跳过');
    expect(result.warnings.join(' ')).not.toContain('强制平仓');
  });

  it('applies take-profit before the next selected signal', () => {
    const candles = [
      candle(300_000, 100, 115, 95, 108),
      candle(600_000, 100, 102, 98, 100),
      candle(900_000, 100, 102, 98, 100),
    ];
    const result = calculatePositions({
      triggers: [
        trigger(),
        trigger({ triggerAt: 900_000, barOpenTime: 600_000, barCloseTime: 900_000 }),
      ],
      triggerIndexes: [0, 1],
      candles,
      timeframeMs: tfMs,
      endTime: 1_500_000,
      config: config(),
    });
    expect(result.trades).toHaveLength(2);
    expect(result.trades[0].exitReason).toBe('target');
    expect(result.trades[0].exitPrice).toBe(110);
    expect(result.trades[1].equityBefore).toBeCloseTo(1494.75, 8);
    expect(result.trades[1].exitAt).toBeGreaterThanOrEqual(result.trades[0].exitAt);
  });

  it('uses trigger indicator values for dynamic take-profit and validates missing values', () => {
    const withIndicator = trigger({
      conditions: [{
        conditionId: 'bb',
        timeframe: '5m',
        leftSeries: 'price.close',
        rightSeries: 'bb.upper',
        leftValue: 100,
        rightValue: 110,
        cmp: 'gte',
        truth: true,
        barOpenTime: 0,
        barCloseTime: 300_000,
        leftParams: {},
        rightParams: { length: 20, mult: 2 },
      }],
    });
    const result = calculatePositions({
      triggers: [withIndicator],
      triggerIndexes: [0],
      candles: [candle(300_000, 100, 112, 98, 108)],
      timeframeMs: tfMs,
      endTime: 900_000,
      config: config({ target: { mode: 'indicator', series: 'bb.upper' } }),
    });
    expect(result.trades[0].targetPrice).toBe(110);
    expect(result.trades[0].exitReason).toBe('target');

    expect(() => calculatePositions({
      triggers: [trigger()],
      triggerIndexes: [0],
      candles: [candle(300_000, 100, 112, 98, 108)],
      timeframeMs: tfMs,
      endTime: 900_000,
      config: config({ target: { mode: 'indicator', series: 'bb.upper' } }),
    })).toThrow(PositionCalcError);
  });

  it('honours a stop at the estimated liquidation boundary instead of reporting liquidation', () => {
    const result = calculatePositions({
      triggers: [trigger()],
      triggerIndexes: [0],
      candles: [candle(300_000, 100, 101, 79, 80)],
      timeframeMs: tfMs,
      endTime: 900_000,
      config: config({ target: { mode: 'none' }, stop: { mode: 'percent', percent: 20 } }),
    });
    const trade = result.trades[0];
    expect(trade.stopPrice).toBeCloseTo(80, 8);
    expect(trade.liquidationPrice).toBeCloseTo(80, 8);
    expect(trade.exitReason).toBe('stop');
    expect(trade.equityAfter).toBe(0);
  });

  it('supports a net margin-return stop independent of price percentage', () => {
    const result = calculatePositions({
      triggers: [trigger()],
      triggerIndexes: [0],
      candles: [candle(300_000, 100, 101, 95, 100)],
      timeframeMs: tfMs,
      endTime: 900_000,
      config: config({
        leverage: 10,
        feeRatePct: 0,
        slippagePct: 0,
        target: { mode: 'none' },
        stop: { mode: 'roi', roiPercent: 25 },
      }),
    });
    const trade = result.trades[0];
    expect(trade.exitReason).toBe('stop');
    expect(trade.stopPrice).toBeCloseTo(97.5, 8);
    expect(trade.netPnl).toBeCloseTo(-250, 8);
    expect(trade.roiPct).toBeCloseTo(-25, 8);
    expect(trade.stopBeyondLiquidation).toBe(false);
  });

  it('marks risk/reward unavailable when the stop is beyond liquidation', () => {
    const result = calculatePositions({
      triggers: [trigger()],
      triggerIndexes: [0],
      candles: [candle(300_000, 100, 101, 99, 100)],
      timeframeMs: tfMs,
      endTime: 900_000,
      config: config({ leverage: 40, target: { mode: 'percent', percent: 50 }, stop: { mode: 'percent', percent: 25 } }),
    });
    const trade = result.trades[0];
    expect(trade.stopBeyondLiquidation).toBe(true);
    expect(trade.riskReward).toBeNull();
    expect(result.warnings.join(' ')).toContain('盈亏比不可用');
  });

  it('caps isolated-margin losses at the allocated capital when liquidated', () => {
    const result = calculatePositions({
      triggers: [trigger()],
      triggerIndexes: [0],
      candles: [candle(300_000, 100, 101, 80, 85)],
      timeframeMs: tfMs,
      endTime: 900_000,
      config: config({ leverage: 10, target: { mode: 'none' }, stop: { mode: 'none' } }),
    });
    const trade = result.trades[0];
    expect(trade.exitReason).toBe('liquidation');
    expect(trade.equityAfter).toBe(0);
    expect(trade.netPnl).toBe(-1_000);
  });

  it('liquidates a short position at the estimated liquidation level', () => {
    const result = calculatePositions({
      triggers: [trigger()],
      triggerIndexes: [0],
      candles: [candle(300_000, 100, 112, 99, 110)],
      timeframeMs: tfMs,
      endTime: 900_000,
      config: config({ direction: 'short', leverage: 10, target: { mode: 'none' }, stop: { mode: 'none' } }),
    });
    expect(result.trades[0].exitReason).toBe('liquidation');
    expect(result.trades[0].equityAfter).toBe(0);
  });

  it('rejects invalid parameters and target/stop sides', () => {
    expect(() => calculatePositions({
      triggers: [trigger()],
      triggerIndexes: [0],
      candles: [candle(300_000, 100, 101, 99, 100)],
      timeframeMs: tfMs,
      endTime: 900_000,
      config: config({ leverage: 0 }),
    })).toThrow('杠杆');
    expect(() => calculatePositions({
      triggers: [trigger()],
      triggerIndexes: [0],
      candles: [candle(300_000, 100, 101, 99, 100)],
      timeframeMs: tfMs,
      endTime: 900_000,
      config: config({ target: { mode: 'price', price: 95 } }),
    })).toThrow('止盈价');
  });
});
