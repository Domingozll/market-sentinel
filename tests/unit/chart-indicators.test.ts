import { describe, expect, it } from 'vitest';
import {
  activeChartSubPanes,
  chartIndicatorLegend,
  CHART_INDICATOR_STORAGE_KEY,
  DEFAULT_CHART_INDICATORS,
  loadChartIndicatorSettings,
  parseStoredChartIndicatorSettings,
  sanitizeChartIndicatorSettings,
  saveChartIndicatorSettings,
  toggleChartIndicator,
} from '../../src/web/lib/chartIndicators';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe('chart indicator settings', () => {
  it('returns complete defaults for empty and malformed input', () => {
    expect(sanitizeChartIndicatorSettings(null)).toEqual(DEFAULT_CHART_INDICATORS);
    expect(sanitizeChartIndicatorSettings({ boll: true, kdj: 'bad' })).toEqual(DEFAULT_CHART_INDICATORS);
    expect(parseStoredChartIndicatorSettings('{not json')).toEqual(DEFAULT_CHART_INDICATORS);
    expect(parseStoredChartIndicatorSettings(null)).toEqual(DEFAULT_CHART_INDICATORS);
  });

  it('clamps ranges and guarantees MACD slow > fast', () => {
    const settings = sanitizeChartIndicatorSettings({
      boll: { enabled: false, length: 1, mult: 99 },
      volume: { enabled: true, maLength: 0 },
      kdj: { enabled: true, length: 999, kSmooth: 0, dSmooth: 99 },
      rsi: { enabled: true, length: -3 },
      macd: { enabled: true, fast: 30, slow: 20, signal: 0 },
    });
    expect(settings.boll).toEqual({ enabled: false, length: 2, mult: 10 });
    expect(settings.volume.maLength).toBe(1);
    expect(settings.kdj).toEqual({ enabled: true, length: 200, kSmooth: 1, dSmooth: 20 });
    expect(settings.rsi).toEqual({ enabled: true, length: 2 });
    expect(settings.macd).toEqual({ enabled: true, fast: 30, slow: 31, signal: 2 });
  });

  it('supports toggling and derives active sub-panes in a stable order', () => {
    const settings = tabSettings();
    expect(activeChartSubPanes(settings)).toEqual(['volume', 'kdj', 'rsi', 'macd']);
    const without = toggleChartIndicator(toggleChartIndicator(settings, 'rsi'), 'volume');
    expect(without.rsi.enabled).toBe(false);
    expect(without.volume.enabled).toBe(false);
    expect(activeChartSubPanes(without)).toEqual(['kdj', 'macd']);
  });

  it('builds legend labels from enabled indicators and their parameters', () => {
    expect(chartIndicatorLegend(DEFAULT_CHART_INDICATORS).map((item) => item.label)).toEqual(['BOLL(20,2)', 'VOL(20)']);
    const legend = chartIndicatorLegend(tabSettings());
    expect(legend.map((item) => item.label)).toEqual([
      'BOLL(26,2.5)', 'VOL(30)', 'KDJ(12,4,5)', 'RSI(21)', 'MACD(8,21,5)',
    ]);
  });

  it('persists sanitized settings and recovers from corrupt storage', () => {
    const storage = memoryStorage();
    const settings = sanitizeChartIndicatorSettings({
      ...tabSettings(),
      boll: { enabled: true, length: 26.4, mult: 2.46 },
    });
    saveChartIndicatorSettings(settings, storage);
    expect(storage.values.get(CHART_INDICATOR_STORAGE_KEY)).toBeTruthy();
    expect(loadChartIndicatorSettings(storage)).toEqual(settings);
    storage.values.set(CHART_INDICATOR_STORAGE_KEY, '{broken');
    expect(loadChartIndicatorSettings(storage)).toEqual(DEFAULT_CHART_INDICATORS);
  });
});

function tabSettings() {
  return sanitizeChartIndicatorSettings({
    boll: { enabled: true, length: 26, mult: 2.5 },
    volume: { enabled: true, maLength: 30 },
    kdj: { enabled: true, length: 12, kSmooth: 4, dSmooth: 5 },
    rsi: { enabled: true, length: 21 },
    macd: { enabled: true, fast: 8, slow: 21, signal: 5 },
  });
}
