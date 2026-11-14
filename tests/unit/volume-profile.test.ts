import { describe, expect, it } from 'vitest';
import { computeVolumeProfile } from '../../src/web/lib/chart/volumeProfile';
import { normalizeBars, toKLineData } from '../../src/web/lib/chart/dataLoader';
import {
  defaultChartWorkspace,
  loadWorkspace,
  sanitizeWorkspace,
  saveWorkspace,
} from '../../src/web/lib/chart/indicatorSettings';
import { CHART_WORKSPACE_STORAGE_KEY } from '../../src/web/lib/chart/types';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
    clear: () => data.clear(),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() { return data.size; },
  } as Storage;
}

describe('Volume Profile', () => {
  it('aggregates turnover into price bins and finds POC and value area', () => {
    const profile = computeVolumeProfile([
      { low: 100, high: 110, turnover: 100 },
      { low: 110, high: 120, turnover: 300 },
    ], 10);
    expect(profile.totalVolume).toBe(400);
    expect(profile.bins.reduce((sum, bin) => sum + bin.volume, 0)).toBeCloseTo(400);
    expect(profile.poc).not.toBeNull();
    expect(profile.poc!).toBeGreaterThanOrEqual(100);
    expect(profile.poc!).toBeLessThanOrEqual(120);
    expect(profile.valueLow).not.toBeNull();
    expect(profile.valueHigh).not.toBeNull();
    expect(profile.valueLow!).toBeLessThanOrEqual(profile.poc!);
    expect(profile.valueHigh!).toBeGreaterThanOrEqual(profile.poc!);
    expect(profile.maxVolume).toBeGreaterThan(0);
  });

  it('returns an empty profile for no bars, invalid ranges or zero turnover', () => {
    expect(computeVolumeProfile([]).bins).toEqual([]);
    expect(computeVolumeProfile([{ low: 100, high: 100, turnover: 10 }]).bins).toEqual([]);
    const zero = computeVolumeProfile([{ low: 100, high: 110, turnover: 0 }], 20);
    expect(zero.bins).toHaveLength(20);
    expect(zero.totalVolume).toBe(0);
    expect(zero.poc).toBeNull();
    expect(zero.valueLow).toBeNull();
  });

  it('normalizes chart bars and rejects invalid candles', () => {
    const bars = normalizeBars([
      { instId: 'BTC-USDT-SWAP', timeframe: '5m', openTime: 2, open: 2, high: 3, low: 1, close: 2.5, volume: 12, vol: 1, volCcy: 1, volCcyQuote: 12, confirm: true },
      { instId: 'BTC-USDT-SWAP', timeframe: '5m', openTime: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 8, vol: 1, volCcy: 1, volCcyQuote: 8, confirm: true },
      { instId: 'BTC-USDT-SWAP', timeframe: '5m', openTime: 3, open: Number.NaN, high: 3, low: 1, close: 2, volume: 1, vol: 1, volCcy: 1, volCcyQuote: 1, confirm: true },
    ]);
    expect(bars.map((bar) => bar.timestamp)).toEqual([1, 2]);
    expect(toKLineData({ instId: 'BTC-USDT-SWAP', timeframe: '5m', openTime: 5, open: 1, high: 2, low: 0.5, close: 1.5, volume: 9, vol: 1, volCcy: 1, volCcyQuote: 9, confirm: false })).toMatchObject({ timestamp: 5, volume: 9, turnover: 9 });
  });
});

describe('chart workspace persistence', () => {
  it('sanitizes invalid settings and persists a versioned workspace', () => {
    const storage = memoryStorage();
    const workspace = defaultChartWorkspace();
    workspace.indicators.boll.length = 9999;
    workspace.indicators.ma.periods = [1, 5, 5, 300];
    workspace.volumeProfile.bins = 7;
    workspace.drawings['BTC-USDT-SWAP|5m'] = [{
      name: 'segment',
      points: [{ timestamp: 1, value: 2 }],
    }];
    saveWorkspace(workspace, storage);
    const loaded = loadWorkspace(storage);
    expect(loaded.version).toBe(1);
    expect(loaded.indicators.boll.length).toBe(200);
    expect(loaded.indicators.ma.periods).toEqual([5]);
    expect(loaded.volumeProfile.bins).toBe(20);
    expect(loaded.drawings['BTC-USDT-SWAP|5m']).toHaveLength(1);
    expect(JSON.parse(storage.getItem(CHART_WORKSPACE_STORAGE_KEY)!)).toBeTruthy();
  });

  it('falls back to defaults for malformed storage', () => {
    const storage = memoryStorage();
    storage.setItem(CHART_WORKSPACE_STORAGE_KEY, '{broken');
    expect(loadWorkspace(storage).indicators.boll.length).toBe(20);
    expect(sanitizeWorkspace({ volumeProfile: { bins: 'x' } }).volumeProfile.bins).toBe(80);
  });
});
