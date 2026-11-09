export const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1H', '2H', '4H', '1D'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const TF_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1H': 3_600_000,
  '2H': 7_200_000,
  '4H': 14_400_000,
  '1D': 86_400_000,
};

/** OKX bar codes are the same as our display labels for the supported set. */
export const TF_TO_OKX_BAR = Object.fromEntries(TIMEFRAMES.map((tf) => [tf, tf])) as Record<Timeframe, string>;

export const TRIGGER_MODES = ['close', 'intrabar'] as const;
export type TriggerMode = (typeof TRIGGER_MODES)[number];
export const TRIGGER_MODE_LABEL: Record<TriggerMode, string> = {
  close: '收盘确认',
  intrabar: '盘中触发',
};

export const COMPARATORS = ['gt', 'gte', 'lt', 'lte'] as const;
export type Comparator = (typeof COMPARATORS)[number];
export const COMPARATOR_LABEL: Record<Comparator, string> = {
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
};

export const SERIES_KEYS = [
  'price.open',
  'price.high',
  'price.low',
  'price.close',
  'bb.upper',
  'bb.middle',
  'bb.lower',
  'bb.bandwidth',
  'bb.percentB',
  'bb.midSlope',
  'kdj.k',
  'kdj.d',
  'kdj.j',
  'rsi.rsi',
  'macd.dif',
  'macd.dea',
  'macd.hist',
  'volume.quote',
  'volume.ma',
  'volume.ratio',
] as const;
export type SeriesKey = (typeof SERIES_KEYS)[number];

export type SeriesUnit = 'price' | 'percent' | 'points' | 'momentum' | 'volume' | 'ratio' | 'percentPerBar';
export type SeriesGroup = 'price' | 'bb' | 'kdj' | 'rsi' | 'macd' | 'volume';

export interface SeriesMeta {
  key: SeriesKey;
  label: string;
  group: SeriesGroup;
  groupLabel: string;
  unit: SeriesUnit;
  description: string;
  paramsKind?: 'bb' | 'kdj' | 'rsi' | 'macd' | 'volume';
}

export const SERIES_CATALOG: Record<SeriesKey, SeriesMeta> = {
  'price.open': { key: 'price.open', label: '开盘价', group: 'price', groupLabel: '价格', unit: 'price', description: 'K 线开盘价' },
  'price.high': { key: 'price.high', label: '最高价', group: 'price', groupLabel: '价格', unit: 'price', description: 'K 线最高价，用于判断向上触及' },
  'price.low': { key: 'price.low', label: '最低价', group: 'price', groupLabel: '价格', unit: 'price', description: 'K 线最低价，用于判断向下触及' },
  'price.close': { key: 'price.close', label: '收盘价', group: 'price', groupLabel: '价格', unit: 'price', description: 'K 线收盘价' },
  'bb.upper': { key: 'bb.upper', label: '布林带上轨', group: 'bb', groupLabel: '布林带', unit: 'price', description: '中轨 + k × 总体标准差', paramsKind: 'bb' },
  'bb.middle': { key: 'bb.middle', label: '布林带中轨', group: 'bb', groupLabel: '布林带', unit: 'price', description: '收盘价简单移动平均', paramsKind: 'bb' },
  'bb.lower': { key: 'bb.lower', label: '布林带下轨', group: 'bb', groupLabel: '布林带', unit: 'price', description: '中轨 − k × 总体标准差', paramsKind: 'bb' },
  'bb.bandwidth': { key: 'bb.bandwidth', label: '布林带带宽', group: 'bb', groupLabel: '布林带', unit: 'percent', description: '(上轨 − 下轨) / 中轨 × 100%', paramsKind: 'bb' },
  'bb.percentB': { key: 'bb.percentB', label: '布林带 %B', group: 'bb', groupLabel: '布林带', unit: 'ratio', description: '(收盘价 − 下轨) / (上轨 − 下轨)', paramsKind: 'bb' },
  'bb.midSlope': { key: 'bb.midSlope', label: '中轨斜率', group: 'bb', groupLabel: '布林带', unit: 'percentPerBar', description: '中轨在 k 根内的归一化变化，单位 %/根', paramsKind: 'bb' },
  'kdj.k': { key: 'kdj.k', label: 'KDJ · K', group: 'kdj', groupLabel: 'KDJ', unit: 'points', description: 'RSV 的平滑值', paramsKind: 'kdj' },
  'kdj.d': { key: 'kdj.d', label: 'KDJ · D', group: 'kdj', groupLabel: 'KDJ', unit: 'points', description: 'K 的再平滑值', paramsKind: 'kdj' },
  'kdj.j': { key: 'kdj.j', label: 'KDJ · J', group: 'kdj', groupLabel: 'KDJ', unit: 'points', description: '3K − 2D，可超出 0–100', paramsKind: 'kdj' },
  'rsi.rsi': { key: 'rsi.rsi', label: 'RSI', group: 'rsi', groupLabel: 'RSI', unit: 'points', description: 'Wilder RSI，0–100', paramsKind: 'rsi' },
  'macd.dif': { key: 'macd.dif', label: 'MACD · DIF', group: 'macd', groupLabel: 'MACD', unit: 'momentum', description: '快 EMA − 慢 EMA', paramsKind: 'macd' },
  'macd.dea': { key: 'macd.dea', label: 'MACD · DEA', group: 'macd', groupLabel: 'MACD', unit: 'momentum', description: 'DIF 的 EMA', paramsKind: 'macd' },
  'macd.hist': { key: 'macd.hist', label: 'MACD · 柱', group: 'macd', groupLabel: 'MACD', unit: 'momentum', description: 'DIF − DEA，不乘 2', paramsKind: 'macd' },
  'volume.quote': { key: 'volume.quote', label: '成交量', group: 'volume', groupLabel: '成交量', unit: 'volume', description: '报价货币成交额（OKX volCcyQuote）' },
  'volume.ma': { key: 'volume.ma', label: '成交量均线', group: 'volume', groupLabel: '成交量', unit: 'volume', description: '成交量的简单移动平均', paramsKind: 'volume' },
  'volume.ratio': { key: 'volume.ratio', label: '量能倍数', group: 'volume', groupLabel: '成交量', unit: 'ratio', description: '当前成交量 / 成交量 SMA(N)', paramsKind: 'volume' },
};

export const SERIES_GROUPS: { key: SeriesGroup; label: string; series: SeriesKey[] }[] = [
  { key: 'price', label: '价格', series: ['price.open', 'price.high', 'price.low', 'price.close'] },
  { key: 'bb', label: '布林带', series: ['bb.upper', 'bb.middle', 'bb.lower', 'bb.bandwidth', 'bb.percentB', 'bb.midSlope'] },
  { key: 'kdj', label: 'KDJ', series: ['kdj.k', 'kdj.d', 'kdj.j'] },
  { key: 'rsi', label: 'RSI', series: ['rsi.rsi'] },
  { key: 'macd', label: 'MACD', series: ['macd.dif', 'macd.dea', 'macd.hist'] },
  { key: 'volume', label: '成交量', series: ['volume.quote', 'volume.ma', 'volume.ratio'] },
];

export interface IndicatorParams {
  length?: number;
  mult?: number;
  slopeWindow?: number;
  kSmooth?: number;
  dSmooth?: number;
  fast?: number;
  slow?: number;
  signal?: number;
  maLength?: number;
}

export const DEFAULT_PARAMS = {
  bb: { length: 20, mult: 2, slopeWindow: 1 },
  kdj: { length: 9, kSmooth: 3, dSmooth: 3 },
  rsi: { length: 14 },
  macd: { fast: 12, slow: 26, signal: 9 },
  volume: { maLength: 20 },
} as const;

export function defaultParamsFor(series: SeriesKey): IndicatorParams {
  const kind = SERIES_CATALOG[series].paramsKind;
  return kind ? { ...DEFAULT_PARAMS[kind] } : {};
}

export function normalizeParams(series: SeriesKey, params: IndicatorParams | undefined): IndicatorParams {
  const defaults = defaultParamsFor(series);
  if (!params) return defaults;
  const allowed = new Set(Object.keys(defaults));
  const out: IndicatorParams = { ...defaults };
  for (const [key, value] of Object.entries(params)) {
    if (!allowed.has(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) {
      (out as Record<string, number>)[key] = value;
    }
  }
  return out;
}

export type SeriesRef = { series: SeriesKey; params?: IndicatorParams };
export type NumericRef =
  | { type: 'number'; value: number }
  | { type: 'series'; series: SeriesKey; params?: IndicatorParams };

export interface Condition {
  kind: 'condition';
  id: string;
  timeframe: Timeframe;
  left: SeriesRef;
  cmp: Comparator;
  right: NumericRef;
}

export interface ConditionGroup {
  kind: 'group';
  op: 'AND' | 'OR';
  children: ExpressionNode[];
}

export type ExpressionNode = Condition | ConditionGroup;

export interface RuleDraft {
  name: string;
  symbols: string[];
  triggerMode: TriggerMode;
  cooldownSec: number;
  expression: ExpressionNode;
  note?: string;
}

export interface Rule extends RuleDraft {
  id: string;
  enabled: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export const MAX_CONDITIONS = 12;
export const MAX_GROUP_DEPTH = 3;
export const MIN_HISTORY_BARS = 200;
export const DEFAULT_COOLDOWN_SEC = 300;
export const DEFAULT_RETENTION_DAYS = 90;
export const MAX_ALERT_GRACE_MS = 120_000;

export interface Candle {
  instId: string;
  timeframe: Timeframe;
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Quote-currency turnover (OKX volCcyQuote). */
  volume: number;
  vol: number;
  volCcy: number;
  volCcyQuote: number;
  confirm: boolean;
}

export type RuleStateStatus = 'paused' | 'warming' | 'armed' | 'satisfied' | 'degraded';

export interface RuleState {
  ruleId: string;
  symbol: string;
  ruleVersion: number;
  lastTruth: boolean | null;
  lastEvalAt: number | null;
  lastEvalBarClose: number | null;
  lastTriggerAt: number | null;
  status: RuleStateStatus;
  detail: Record<string, unknown> | null;
}

export interface ConditionEvaluation {
  conditionId: string;
  timeframe: Timeframe;
  leftSeries: SeriesKey;
  rightSeries: SeriesKey | null;
  leftValue: number | null;
  rightValue: number | null;
  cmp: Comparator;
  truth: boolean;
  barOpenTime: number;
  barCloseTime: number;
  leftParams: IndicatorParams;
  rightParams: IndicatorParams | null;
}

export interface RuleEvaluation {
  symbol: string;
  truth: boolean;
  conditions: ConditionEvaluation[];
  price: number | null;
  triggerBarTs: number | null;
  triggerBarCloseTs: number | null;
  referenceTimeframe: Timeframe | null;
  asOf: number;
}

export type AggregateRuleStatus = 'paused' | 'warming' | 'armed' | 'satisfied' | 'degraded';

export interface RuleStateView extends RuleState {
  statusLabel: string;
}

export interface RuleView extends Rule {
  summary: string;
  ruleStatus: AggregateRuleStatus;
  statusLabel: string;
  states: RuleStateView[];
  lastTriggerAt: number | null;
  triggerCount24h: number;
  timeframes: Timeframe[];
}

export interface DeliveryInfo {
  status: 'pending' | 'sending' | 'sent' | 'dead' | 'skipped';
  attempts: number;
  lastHttpStatus: number | null;
  lastError: string | null;
  externalMessageId: string | null;
  nextAttemptAt: number | null;
  updatedAt: number;
}

export interface EventView {
  id: string;
  ruleId: string | null;
  ruleName: string;
  ruleVersion: number;
  symbol: string;
  triggerMode: TriggerMode;
  triggerBarTs: number;
  triggerAt: number;
  price: number;
  closeConfirmed: boolean | null;
  conditions: ConditionEvaluation[];
  expression: ExpressionNode;
  note: string;
  createdAt: number;
  delivery: DeliveryInfo | null;
}

export interface MarketPairStatus {
  instId: string;
  timeframe: Timeframe;
  state: 'warming' | 'healthy' | 'stale' | 'gap' | 'disconnected';
  latestClosedOpen: number | null;
  latestClosedAt: number | null;
  lastReceivedAt: number | null;
  bars: number;
}

export interface DashboardStats {
  activeRules: number;
  totalRules: number;
  todayEvents: number;
  deliverySuccess: number;
  deliveryTotal: number;
  marketLatencyMs: number | null;
}

export interface AppStatus {
  ok: boolean;
  now: number;
  exchangeNow: number;
  wsConnected: boolean;
  wsState: string;
  discordConfigured: boolean;
  proxyEnabled: boolean;
  version: string;
  startedAt: number;
  error?: string;
}

export interface PublicSettings {
  discordConfigured: boolean;
  discordWebhookMasked: string;
  proxyUrl: string;
  useProxyForDiscord: boolean;
  defaultCooldownSec: number;
  eventRetentionDays: number;
  okxRestBase: string;
  okxWsUrl: string;
  timezone: string;
}

export interface DiagnosticInfo {
  app: AppStatus;
  marketPairs: MarketPairStatus[];
  deliveryQueue: { pending: number; dead: number; sent: number; skipped: number };
  dataCounts: { events: number; candles: number; databaseBytes: number };
  recentErrors: { at: number; message: string }[];
}

export interface TrialResult {
  triggerCount: number;
  perDay: number;
  windowDays: number;
  symbol: string;
  timeframe: Timeframe;
  triggers: {
    triggerAt: number;
    price: number;
    conditions: ConditionEvaluation[];
    truth: boolean;
    alreadyMatched: boolean;
    markerType: 'trigger';
  }[];
  candles: { openTime: number; open: number; high: number; low: number; close: number; volume: number }[];
  indicators: { upper: (number | null)[]; middle: (number | null)[]; lower: (number | null)[] };
  warning: string;
}

export const AGGREGATE_STATUS_LABEL: Record<AggregateRuleStatus, string> = {
  paused: '已暂停',
  warming: '预热中',
  armed: '监控中',
  satisfied: '已满足',
  degraded: '数据异常',
};

export const DELIVERY_STATUS_LABEL: Record<DeliveryInfo['status'], string> = {
  pending: '待发送',
  sending: '发送中',
  sent: '已送达',
  dead: '发送失败',
  skipped: '未通知',
};
