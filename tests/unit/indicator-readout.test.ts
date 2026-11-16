import { describe, expect, it } from 'vitest';
import type { KLineData } from 'klinecharts';
import { DEFAULT_CHART_INDICATORS } from '../../src/web/lib/chart/indicatorSettings';
import { computeIndicatorLegend } from '../../src/web/lib/chart/indicatorReadout';

function bars(count = 160): KLineData[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: i * 300_000,
    open: 100 + i * 0.2,
    high: 101 + i * 0.2,
    low: 99 + i * 0.2,
    close: 100.5 + i * 0.2,
    volume: 1_000 + i,
    turnover: 2_000 + i,
  }));
}

describe('indicator readout', () => {
  it('returns names, params and current values for all enabled indicators', () => {
    const config = {
      ...DEFAULT_CHART_INDICATORS,
      rsi: { ...DEFAULT_CHART_INDICATORS.rsi, enabled: true },
      kdj: { ...DEFAULT_CHART_INDICATORS.kdj, enabled: true },
      macd: { ...DEFAULT_CHART_INDICATORS.macd, enabled: true },
      ma: { ...DEFAULT_CHART_INDICATORS.ma, enabled: true },
    };
    const data = bars();
    const items = computeIndicatorLegend(config, data, data.length - 1);
    expect(items.map((item) => item.name)).toEqual(['BOLL', 'VOL', 'KDJ', 'RSI', 'MACD', 'MA']);
    expect(items.find((item) => item.name === 'BOLL')?.params).toBe('(20,2)');
    expect(items.find((item) => item.name === 'BOLL')?.values.map((v) => v.label)).toEqual(['U', 'M', 'L']);
    expect(items.find((item) => item.name === 'VOL')?.values[0].value).toBeGreaterThan(0);
    expect(items.find((item) => item.name === 'RSI')?.values[0].value).not.toBeNull();
    expect(items.find((item) => item.name === 'MACD')?.values.map((v) => v.label)).toEqual(['DIF', 'DEA', 'HIST']);
  });

  it('keeps hidden indicators in the legend and handles empty data', () => {
    const config = {
      ...DEFAULT_CHART_INDICATORS,
      rsi: { ...DEFAULT_CHART_INDICATORS.rsi, enabled: true, visible: false },
    };
    const items = computeIndicatorLegend(config, bars(), 10);
    expect(items.find((item) => item.name === 'RSI')?.visible).toBe(false);
    expect(computeIndicatorLegend(config, [], 0)).toEqual([]);
  });
});
