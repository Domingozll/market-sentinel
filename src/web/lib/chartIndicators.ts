export type ChartSubPaneKey = 'volume' | 'kdj' | 'rsi' | 'macd';
export type ChartIndicatorKey = 'boll' | ChartSubPaneKey;

export interface BollChartSettings {
  enabled: boolean;
  length: number;
  mult: number;
}

export interface VolumeChartSettings {
  enabled: boolean;
  maLength: number;
}

export interface KdjChartSettings {
  enabled: boolean;
  length: number;
  kSmooth: number;
  dSmooth: number;
}

export interface RsiChartSettings {
  enabled: boolean;
  length: number;
}

export interface MacdChartSettings {
  enabled: boolean;
  fast: number;
  slow: number;
  signal: number;
}

export interface ChartIndicatorSettings {
  boll: BollChartSettings;
  volume: VolumeChartSettings;
  kdj: KdjChartSettings;
  rsi: RsiChartSettings;
  macd: MacdChartSettings;
}

export interface ChartIndicatorMeta {
  key: ChartIndicatorKey;
  label: string;
  short: string;
  color: string;
  pane: 'main' | 'sub';
}

export const CHART_INDICATOR_STORAGE_KEY = 'market-sentinel.chart-indicators.v1';

export const CHART_INDICATOR_META: Record<ChartIndicatorKey, ChartIndicatorMeta> = {
  boll: { key: 'boll', label: 'BOLL 布林带', short: 'BOLL', color: '#71a7ff', pane: 'main' },
  volume: { key: 'volume', label: '成交量', short: 'VOL', color: '#8bd17c', pane: 'sub' },
  kdj: { key: 'kdj', label: 'KDJ 随机指标', short: 'KDJ', color: '#f0c06a', pane: 'sub' },
  rsi: { key: 'rsi', label: 'RSI 相对强弱', short: 'RSI', color: '#f08a6a', pane: 'sub' },
  macd: { key: 'macd', label: 'MACD 指数平滑', short: 'MACD', color: '#a58cff', pane: 'sub' },
};

export const CHART_SUB_PANE_ORDER: ChartSubPaneKey[] = ['volume', 'kdj', 'rsi', 'macd'];

export const DEFAULT_CHART_INDICATORS: ChartIndicatorSettings = {
  boll: { enabled: true, length: 20, mult: 2 },
  volume: { enabled: true, maLength: 20 },
  kdj: { enabled: false, length: 9, kSmooth: 3, dSmooth: 3 },
  rsi: { enabled: false, length: 14 },
  macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
};

export const CHART_INDICATOR_LIMITS = {
  bollLength: { min: 2, max: 200, step: 1 },
  bollMult: { min: 0.1, max: 10, step: 0.1 },
  volumeMa: { min: 1, max: 200, step: 1 },
  kdjLength: { min: 2, max: 200, step: 1 },
  kdjSmooth: { min: 1, max: 20, step: 1 },
  rsiLength: { min: 2, max: 200, step: 1 },
  macdFast: { min: 2, max: 100, step: 1 },
  macdSlow: { min: 3, max: 200, step: 1 },
  macdSignal: { min: 2, max: 100, step: 1 },
} as const;

function defaultSettings(): ChartIndicatorSettings {
  return {
    boll: { ...DEFAULT_CHART_INDICATORS.boll },
    volume: { ...DEFAULT_CHART_INDICATORS.volume },
    kdj: { ...DEFAULT_CHART_INDICATORS.kdj },
    rsi: { ...DEFAULT_CHART_INDICATORS.rsi },
    macd: { ...DEFAULT_CHART_INDICATORS.macd },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function numberValue(value: unknown, fallback: number, min: number, max: number, step = 1): number {
  const parsed = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  const clamped = Math.min(max, Math.max(min, parsed));
  if (step <= 0) return clamped;
  const rounded = Math.round(clamped / step) * step;
  return Number(rounded.toFixed(step < 1 ? 1 : 0));
}

/** Coerce untrusted/localStorage input into a complete, bounded chart configuration. */
export function sanitizeChartIndicatorSettings(input: unknown): ChartIndicatorSettings {
  const source = record(input) ?? {};
  const boll = record(source.boll) ?? {};
  const volume = record(source.volume) ?? {};
  const kdj = record(source.kdj) ?? {};
  const rsi = record(source.rsi) ?? {};
  const macd = record(source.macd) ?? {};

  let fast = numberValue(macd.fast, DEFAULT_CHART_INDICATORS.macd.fast, 2, 100, 1);
  let slow = numberValue(macd.slow, DEFAULT_CHART_INDICATORS.macd.slow, 3, 200, 1);
  if (slow <= fast) slow = Math.min(200, fast + 1);
  const signal = numberValue(macd.signal, DEFAULT_CHART_INDICATORS.macd.signal, 2, 100, 1);

  return {
    boll: {
      enabled: booleanValue(boll.enabled, DEFAULT_CHART_INDICATORS.boll.enabled),
      length: numberValue(boll.length, DEFAULT_CHART_INDICATORS.boll.length, 2, 200, 1),
      mult: numberValue(boll.mult, DEFAULT_CHART_INDICATORS.boll.mult, 0.1, 10, 0.1),
    },
    volume: {
      enabled: booleanValue(volume.enabled, DEFAULT_CHART_INDICATORS.volume.enabled),
      maLength: numberValue(volume.maLength, DEFAULT_CHART_INDICATORS.volume.maLength, 1, 200, 1),
    },
    kdj: {
      enabled: booleanValue(kdj.enabled, DEFAULT_CHART_INDICATORS.kdj.enabled),
      length: numberValue(kdj.length, DEFAULT_CHART_INDICATORS.kdj.length, 2, 200, 1),
      kSmooth: numberValue(kdj.kSmooth, DEFAULT_CHART_INDICATORS.kdj.kSmooth, 1, 20, 1),
      dSmooth: numberValue(kdj.dSmooth, DEFAULT_CHART_INDICATORS.kdj.dSmooth, 1, 20, 1),
    },
    rsi: {
      enabled: booleanValue(rsi.enabled, DEFAULT_CHART_INDICATORS.rsi.enabled),
      length: numberValue(rsi.length, DEFAULT_CHART_INDICATORS.rsi.length, 2, 200, 1),
    },
    macd: {
      enabled: booleanValue(macd.enabled, DEFAULT_CHART_INDICATORS.macd.enabled),
      fast,
      slow,
      signal,
    },
  };
}

export function parseStoredChartIndicatorSettings(raw: string | null): ChartIndicatorSettings {
  if (!raw) return defaultSettings();
  try {
    return sanitizeChartIndicatorSettings(JSON.parse(raw));
  } catch {
    return defaultSettings();
  }
}

type ChartStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function loadChartIndicatorSettings(storage?: ChartStorage | null): ChartIndicatorSettings {
  try {
    const target = storage === undefined ? (typeof window === 'undefined' ? null : window.localStorage) : storage;
    if (!target) return defaultSettings();
    return parseStoredChartIndicatorSettings(target.getItem(CHART_INDICATOR_STORAGE_KEY));
  } catch {
    return defaultSettings();
  }
}

export function saveChartIndicatorSettings(settings: ChartIndicatorSettings, storage?: ChartStorage | null): void {
  try {
    const target = storage === undefined ? (typeof window === 'undefined' ? null : window.localStorage) : storage;
    if (!target) return;
    target.setItem(CHART_INDICATOR_STORAGE_KEY, JSON.stringify(sanitizeChartIndicatorSettings(settings)));
  } catch {
    // Private browsing/quota can make localStorage unavailable; chart settings are non-critical.
  }
}

export function toggleChartIndicator(settings: ChartIndicatorSettings, key: ChartIndicatorKey): ChartIndicatorSettings {
  return sanitizeChartIndicatorSettings({
    ...settings,
    [key]: { ...settings[key], enabled: !settings[key].enabled },
  });
}

export function activeChartSubPanes(settings: ChartIndicatorSettings): ChartSubPaneKey[] {
  return CHART_SUB_PANE_ORDER.filter((key) => settings[key].enabled);
}

function compactValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export interface ChartLegendItem {
  key: ChartIndicatorKey;
  label: string;
  color: string;
}

export function chartIndicatorLegend(settings: ChartIndicatorSettings): ChartLegendItem[] {
  const items: ChartLegendItem[] = [];
  if (settings.boll.enabled) {
    items.push({
      key: 'boll',
      label: `BOLL(${settings.boll.length},${compactValue(settings.boll.mult)})`,
      color: CHART_INDICATOR_META.boll.color,
    });
  }
  if (settings.volume.enabled) {
    items.push({
      key: 'volume',
      label: `VOL(${settings.volume.maLength})`,
      color: CHART_INDICATOR_META.volume.color,
    });
  }
  if (settings.kdj.enabled) {
    items.push({
      key: 'kdj',
      label: `KDJ(${settings.kdj.length},${settings.kdj.kSmooth},${settings.kdj.dSmooth})`,
      color: CHART_INDICATOR_META.kdj.color,
    });
  }
  if (settings.rsi.enabled) {
    items.push({
      key: 'rsi',
      label: `RSI(${settings.rsi.length})`,
      color: CHART_INDICATOR_META.rsi.color,
    });
  }
  if (settings.macd.enabled) {
    items.push({
      key: 'macd',
      label: `MACD(${settings.macd.fast},${settings.macd.slow},${settings.macd.signal})`,
      color: CHART_INDICATOR_META.macd.color,
    });
  }
  return items;
}
