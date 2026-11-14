import { loadChartIndicatorSettings } from '../chartIndicators';
import {
  CHART_WORKSPACE_STORAGE_KEY,
  LEGACY_CHART_INDICATOR_KEY,
  type ChartIndicatorConfig,
  type ChartIndicatorKey,
  type ChartWorkspaceState,
  type DrawingTool,
  type DrawingsByKey,
  type SerializedOverlay,
  type VolumeProfileSettings,
} from './types';

export const DEFAULT_CHART_INDICATORS: ChartIndicatorConfig = {
  boll: { enabled: true, length: 20, mult: 2 },
  volume: { enabled: true, maLength: 20 },
  kdj: { enabled: false, length: 9, kSmooth: 3, dSmooth: 3 },
  rsi: { enabled: false, length: 14 },
  macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
  ma: { enabled: false, periods: [5, 10, 20, 60] },
};

export const DEFAULT_VOLUME_PROFILE: VolumeProfileSettings = {
  enabled: true,
  bins: 80,
  showValueArea: true,
  showPoc: true,
};

export function defaultChartWorkspace(): ChartWorkspaceState {
  return {
    version: 1,
    indicators: cloneIndicators(DEFAULT_CHART_INDICATORS),
    volumeProfile: { ...DEFAULT_VOLUME_PROFILE },
    drawings: {},
  };
}

export function cloneIndicators(config: ChartIndicatorConfig): ChartIndicatorConfig {
  return {
    boll: { ...config.boll },
    volume: { ...config.volume },
    kdj: { ...config.kdj },
    rsi: { ...config.rsi },
    macd: { ...config.macd },
    ma: { ...config.ma, periods: [...config.ma.periods] },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function numberIn(value: unknown, fallback: number, min: number, max: number, step = 1): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const clamped = Math.min(max, Math.max(min, parsed));
  return Number((Math.round(clamped / step) * step).toFixed(step < 1 ? 2 : 0));
}

function periods(value: unknown, fallback: number[]): number[] {
  if (!Array.isArray(value)) return [...fallback];
  const clean = value
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= 2 && item <= 200);
  return clean.length ? [...new Set(clean)].sort((a, b) => a - b).slice(0, 6) : [...fallback];
}

export function sanitizeIndicators(input: unknown): ChartIndicatorConfig {
  const source = record(input) ?? {};
  const boll = record(source.boll) ?? {};
  const volume = record(source.volume) ?? {};
  const kdj = record(source.kdj) ?? {};
  const rsi = record(source.rsi) ?? {};
  const macd = record(source.macd) ?? {};
  const ma = record(source.ma) ?? {};
  let fast = numberIn(macd.fast, DEFAULT_CHART_INDICATORS.macd.fast, 2, 100);
  let slow = numberIn(macd.slow, DEFAULT_CHART_INDICATORS.macd.slow, 3, 200);
  if (slow <= fast) slow = Math.min(200, fast + 1);
  return {
    boll: {
      enabled: bool(boll.enabled, DEFAULT_CHART_INDICATORS.boll.enabled),
      length: numberIn(boll.length, DEFAULT_CHART_INDICATORS.boll.length, 2, 200),
      mult: numberIn(boll.mult, DEFAULT_CHART_INDICATORS.boll.mult, 0.1, 10, 0.1),
    },
    volume: {
      enabled: bool(volume.enabled, DEFAULT_CHART_INDICATORS.volume.enabled),
      maLength: numberIn(volume.maLength, DEFAULT_CHART_INDICATORS.volume.maLength, 1, 200),
    },
    kdj: {
      enabled: bool(kdj.enabled, DEFAULT_CHART_INDICATORS.kdj.enabled),
      length: numberIn(kdj.length, DEFAULT_CHART_INDICATORS.kdj.length, 2, 200),
      kSmooth: numberIn(kdj.kSmooth, DEFAULT_CHART_INDICATORS.kdj.kSmooth, 1, 20),
      dSmooth: numberIn(kdj.dSmooth, DEFAULT_CHART_INDICATORS.kdj.dSmooth, 1, 20),
    },
    rsi: {
      enabled: bool(rsi.enabled, DEFAULT_CHART_INDICATORS.rsi.enabled),
      length: numberIn(rsi.length, DEFAULT_CHART_INDICATORS.rsi.length, 2, 200),
    },
    macd: {
      enabled: bool(macd.enabled, DEFAULT_CHART_INDICATORS.macd.enabled),
      fast,
      slow,
      signal: numberIn(macd.signal, DEFAULT_CHART_INDICATORS.macd.signal, 2, 100),
    },
    ma: {
      enabled: bool(ma.enabled, DEFAULT_CHART_INDICATORS.ma.enabled),
      periods: periods(ma.periods, DEFAULT_CHART_INDICATORS.ma.periods),
    },
  };
}

export function sanitizeVolumeProfile(input: unknown): VolumeProfileSettings {
  const source = record(input) ?? {};
  return {
    enabled: bool(source.enabled, DEFAULT_VOLUME_PROFILE.enabled),
    bins: numberIn(source.bins, DEFAULT_VOLUME_PROFILE.bins, 20, 200, 10),
    showValueArea: bool(source.showValueArea, DEFAULT_VOLUME_PROFILE.showValueArea),
    showPoc: bool(source.showPoc, DEFAULT_VOLUME_PROFILE.showPoc),
  };
}

const ALLOWED_DRAWINGS = new Set<DrawingTool>([
  'segment',
  'horizontalStraightLine',
  'rayLine',
  'priceChannelLine',
  'fibonacciLine',
  'simpleAnnotation',
  'brush',
]);

function sanitizeDrawings(input: unknown): DrawingsByKey {
  const source = record(input);
  if (!source) return {};
  const result: DrawingsByKey = {};
  for (const [key, value] of Object.entries(source)) {
    if (!Array.isArray(value)) continue;
    const items: SerializedOverlay[] = [];
    for (const item of value.slice(0, 200)) {
      const overlay = record(item);
      if (!overlay || typeof overlay.name !== 'string' || !ALLOWED_DRAWINGS.has(overlay.name as DrawingTool)) continue;
      if (!Array.isArray(overlay.points) || overlay.points.length < 1 || overlay.points.length > 200) continue;
      const points = overlay.points
        .map((point) => {
          const p = record(point);
          if (!p || typeof p.timestamp !== 'number' || typeof p.value !== 'number') return null;
          if (!Number.isFinite(p.timestamp) || !Number.isFinite(p.value)) return null;
          return { timestamp: p.timestamp, value: p.value, ...(typeof p.dataIndex === 'number' ? { dataIndex: p.dataIndex } : {}) };
        })
        .filter((point): point is NonNullable<typeof point> => point !== null);
      if (!points.length) continue;
      items.push({ name: overlay.name as DrawingTool, points, lock: bool(overlay.lock, false), visible: bool(overlay.visible, true) });
    }
    if (items.length) result[key] = items;
  }
  return result;
}

export function sanitizeWorkspace(input: unknown): ChartWorkspaceState {
  const source = record(input) ?? {};
  return {
    version: 1,
    indicators: sanitizeIndicators(source.indicators),
    volumeProfile: sanitizeVolumeProfile(source.volumeProfile),
    drawings: sanitizeDrawings(source.drawings),
  };
}

function storageOrNull(storage?: Storage | null): Storage | null {
  try {
    if (storage !== undefined) return storage;
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadWorkspace(storage?: Storage | null): ChartWorkspaceState {
  const target = storageOrNull(storage);
  if (!target) return defaultChartWorkspace();
  try {
    const raw = target.getItem(CHART_WORKSPACE_STORAGE_KEY);
    if (raw) return sanitizeWorkspace(JSON.parse(raw));
    const legacy = loadChartIndicatorSettings(target);
    return {
      ...defaultChartWorkspace(),
      indicators: sanitizeIndicators(legacy),
    };
  } catch {
    return defaultChartWorkspace();
  }
}

export function saveWorkspace(workspace: ChartWorkspaceState, storage?: Storage | null): void {
  const target = storageOrNull(storage);
  if (!target) return;
  try {
    target.setItem(CHART_WORKSPACE_STORAGE_KEY, JSON.stringify(sanitizeWorkspace(workspace)));
    target.removeItem(LEGACY_CHART_INDICATOR_KEY);
  } catch {
    // Storage can be unavailable in private browsing or over quota.
  }
}

export function toggleIndicator(config: ChartIndicatorConfig, key: ChartIndicatorKey): ChartIndicatorConfig {
  return sanitizeIndicators({ ...config, [key]: { ...config[key], enabled: !config[key].enabled } });
}
