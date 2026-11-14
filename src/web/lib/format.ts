import {
  COMPARATOR_LABEL,
  SERIES_CATALOG,
  type Condition,
  type ConditionEvaluation,
  type DeliveryInfo,
  type ExpressionNode,
  type IndicatorParams,
  type SeriesKey,
  type TriggerMode,
  normalizeParams,
} from '../../shared/types';

const CST = 'Asia/Shanghai';

function partsFor(ms: number, includeYear: boolean, seconds: boolean): Record<string, string> {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: CST,
    ...(includeYear ? { year: 'numeric' as const } : {}),
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' as const } : {}),
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(ms));
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function formatDateTime(ms: number | null | undefined, includeYear = false, seconds = true): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const p = partsFor(ms, includeYear, seconds);
  return `${includeYear ? `${p.year}-` : ''}${p.month}-${p.day} ${p.hour}:${p.minute}${seconds ? `:${p.second}` : ''}`;
}

export function formatTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const p = partsFor(ms, false, false);
  return `${p.hour}:${p.minute}`;
}

export function formatClockCst(includeSeconds = true): string {
  const p = partsFor(Date.now(), false, includeSeconds);
  return `${p.month}-${p.day} ${p.hour}:${p.minute}${includeSeconds ? `:${p.second}` : ''} CST`;
}

export function formatNumber(value: number | null | undefined, digits?: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const fractionDigits = digits ?? (abs >= 1000 ? 2 : abs >= 1 ? 3 : 6);
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

export function formatPrice(value: number | null | undefined): string {
  return formatNumber(value, 2);
}

export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return formatNumber(value, 2);
}

export function formatDuration(seconds: number): string {
  if (seconds === 0) return '无冷却';
  if (seconds < 60) return `${seconds} 秒`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours} 小时${minutes ? ` ${minutes} 分` : ''}`;
  if (rest === 0) return `${minutes} 分钟`;
  return `${minutes} 分 ${rest} 秒`;
}

export function formatAgo(ms: number | null | undefined): string {
  if (!ms) return '—';
  const diff = Math.max(0, Date.now() - ms);
  if (diff < 60_000) return `${Math.round(diff / 1000)} 秒前`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
  return `${Math.round(diff / 86_400_000)} 天前`;
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export const TRIGGER_MODE_TEXT: Record<TriggerMode, string> = {
  close: '收盘确认',
  intrabar: '盘中触发',
};

export type PillTone = 'success' | 'wait' | 'warn' | 'danger' | 'info' | 'off';

export function aggregateTone(status: string): PillTone {
  switch (status) {
    case 'satisfied':
      return 'success';
    case 'armed':
      return 'wait';
    case 'degraded':
      return 'warn';
    case 'warming':
      return 'info';
    case 'paused':
    default:
      return 'off';
  }
}

export function deliveryTone(status: DeliveryInfo['status'] | undefined): PillTone {
  switch (status) {
    case 'sent':
      return 'success';
    case 'pending':
    case 'sending':
      return 'info';
    case 'dead':
      return 'danger';
    case 'skipped':
    default:
      return 'off';
  }
}

export const DELIVERY_TEXT: Record<DeliveryInfo['status'], string> = {
  pending: '待发送',
  sending: '发送中',
  sent: '已送达',
  dead: '发送失败',
  skipped: '未通知',
};

export function deliveryText(
  delivery: Pick<DeliveryInfo, 'status' | 'channel'> | null | undefined,
  empty = '—',
): string {
  if (!delivery) return empty;
  if (delivery.channel === 'pushplus' && delivery.status === 'sent') return '已受理';
  return DELIVERY_TEXT[delivery.status];
}

export function conditionLabel(condition: Condition): string {
  const left = seriesDisplay(condition.left.series, condition.left.params);
  const right = condition.right.type === 'series'
    ? seriesDisplay(condition.right.series, condition.right.params)
    : formatNumber(condition.right.value);
  return `${condition.timeframe} ${left} ${COMPARATOR_LABEL[condition.cmp]} ${right}`;
}

export function seriesParamsLabel(series: SeriesKey, params?: IndicatorParams): string {
  const meta = SERIES_CATALOG[series];
  if (!meta.paramsKind) return '';
  const p = normalizeParams(series, params);
  switch (meta.paramsKind) {
    case 'bb':
      return `${p.length ?? 20}, ${p.mult ?? 2}${meta.key === 'bb.midSlope' ? `, 斜率 ${p.slopeWindow ?? 1}` : ''}`;
    case 'kdj':
      return `${p.length ?? 9}, ${p.kSmooth ?? 3}, ${p.dSmooth ?? 3}`;
    case 'rsi':
      return `${p.length ?? 14}`;
    case 'macd':
      return `${p.fast ?? 12}, ${p.slow ?? 26}, ${p.signal ?? 9}`;
    case 'volume':
      return `${p.maLength ?? 20}`;
    default:
      return '';
  }
}

export function seriesDisplay(series: SeriesKey, params?: IndicatorParams): string {
  const p = seriesParamsLabel(series, params);
  return `${SERIES_CATALOG[series].label}${p ? `(${p})` : ''}`;
}

function describeNode(node: ExpressionNode, parentOp?: 'AND' | 'OR'): string {
  if (node.kind === 'condition') return conditionLabel(node);
  const joiner = node.op === 'AND' ? ' 并且 ' : ' 或者 ';
  const text = node.children.map((child) => describeNode(child, node.op)).join(joiner);
  return parentOp && parentOp !== node.op ? `（${text}）` : text;
}

export function summarizeExpression(expression: ExpressionNode): string {
  return `当 ${describeNode(expression)} 时`;
}

export function evaluationDisplay(condition: ConditionEvaluation): string {
  const meta = SERIES_CATALOG[condition.leftSeries];
  const right = condition.rightSeries
    ? SERIES_CATALOG[condition.rightSeries].label
    : formatNumber(condition.rightValue);
  const actual = formatNumber(condition.leftValue);
  return `${condition.timeframe} ${meta.label} ${COMPARATOR_LABEL[condition.cmp]} ${right} · 实际 ${actual}${
    meta.unit === 'percentPerBar' ? '%/根' : ''
  }`;
}

export function statusFromTimestamp(ms: number | null | undefined): string {
  if (!ms) return '—';
  return formatDateTime(ms);
}

export function cmToSeconds(minutes: string | number): number {
  const n = typeof minutes === 'number' ? minutes : Number(minutes);
  if (!Number.isFinite(n)) return 300;
  return Math.max(0, Math.min(86_400, Math.round(n * 60)));
}

export function secondsToMinutes(seconds: number): number {
  return Math.max(0, Math.round(seconds / 60));
}


export const MARKET_STATE_LABEL: Record<string, string> = {
  healthy: '正常',
  warming: '预热中',
  stale: '数据延迟',
  gap: '存在缺口',
  disconnected: '已断开',
};
