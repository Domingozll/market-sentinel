import type { Timeframe } from '../../../shared/types';

export const CHART_WORKSPACE_STORAGE_KEY = 'market-sentinel.chart-workspace.v1';
export const LEGACY_CHART_INDICATOR_KEY = 'market-sentinel.chart-indicators.v1';
export const MAX_CHART_BARS = 5_000;
export const INITIAL_CHART_BARS = 500;

export type ChartIndicatorKey = 'boll' | 'volume' | 'kdj' | 'rsi' | 'macd' | 'ma';

export interface BollIndicatorConfig {
  enabled: boolean;
  length: number;
  mult: number;
}
export interface VolumeIndicatorConfig {
  enabled: boolean;
  maLength: number;
}
export interface KdjIndicatorConfig {
  enabled: boolean;
  length: number;
  kSmooth: number;
  dSmooth: number;
}
export interface RsiIndicatorConfig {
  enabled: boolean;
  length: number;
}
export interface MacdIndicatorConfig {
  enabled: boolean;
  fast: number;
  slow: number;
  signal: number;
}
export interface MaIndicatorConfig {
  enabled: boolean;
  periods: number[];
}

export interface ChartIndicatorConfig {
  boll: BollIndicatorConfig;
  volume: VolumeIndicatorConfig;
  kdj: KdjIndicatorConfig;
  rsi: RsiIndicatorConfig;
  macd: MacdIndicatorConfig;
  ma: MaIndicatorConfig;
}

export interface VolumeProfileSettings {
  enabled: boolean;
  bins: number;
  showValueArea: boolean;
  showPoc: boolean;
}

export type DrawingTool =
  | 'segment'
  | 'horizontalStraightLine'
  | 'rayLine'
  | 'priceChannelLine'
  | 'fibonacciLine'
  | 'simpleAnnotation'
  | 'brush';

export interface ChartPoint {
  timestamp: number;
  value: number;
  dataIndex?: number;
}

export type SerializedOverlay = {
  name: DrawingTool;
  points: ChartPoint[];
  lock?: boolean;
  visible?: boolean;
};

export type DrawingsByKey = Record<string, SerializedOverlay[]>;

export interface ChartWorkspaceState {
  version: 1;
  indicators: ChartIndicatorConfig;
  volumeProfile: VolumeProfileSettings;
  drawings: DrawingsByKey;
}

export interface PriceLevelSeries {
  id: string;
  label: string;
  unit: string;
  data: Array<{ price: number; value: number; side?: 'long' | 'short' }>;
  updatedAt: number;
}

export interface ChartEventMarker {
  id: string;
  ruleId: string | null;
  ruleName: string;
  symbol: string;
  triggerAt: number;
  price: number;
  triggerMode: 'close' | 'intrabar';
  note: string;
  deliveryStatus: string | null;
}

export interface OhlcvReadout {
  timestamp: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

export const CHART_TIMEFRAME_LABEL: Record<Timeframe, string> = {
  '1m': '1m',
  '3m': '3m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1H': '1H',
  '2H': '2H',
  '4H': '4H',
  '1D': '1D',
};

export const ALL_CHART_TIMEFRAMES: Timeframe[] = ['1m', '3m', '5m', '15m', '30m', '1H', '2H', '4H', '1D'];

export function toDrawingKey(symbol: string, timeframe: string): string {
  return `${symbol}|${timeframe}`;
}
