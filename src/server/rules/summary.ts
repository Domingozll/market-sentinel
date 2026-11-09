import {
  COMPARATOR_LABEL,
  SERIES_CATALOG,
  type Condition,
  type ExpressionNode,
  type IndicatorParams,
  type NumericRef,
  type SeriesKey,
  normalizeParams,
} from '../../shared/types';

function paramsSuffix(series: SeriesKey, params?: IndicatorParams): string {
  const meta = SERIES_CATALOG[series];
  if (!meta.paramsKind) return '';
  const p = normalizeParams(series, params);
  switch (meta.paramsKind) {
    case 'bb': {
      const slope = meta.key === 'bb.midSlope' ? `,斜率${p.slopeWindow ?? 1}根` : '';
      return `(${p.length ?? 20},${p.mult ?? 2}${slope})`;
    }
    case 'kdj':
      return `(${p.length ?? 9},${p.kSmooth ?? 3},${p.dSmooth ?? 3})`;
    case 'rsi':
      return `(${p.length ?? 14})`;
    case 'macd':
      return `(${p.fast ?? 12},${p.slow ?? 26},${p.signal ?? 9})`;
    case 'volume':
      return `(${p.maLength ?? 20})`;
    default:
      return '';
  }
}

export function seriesLabel(series: SeriesKey, params?: IndicatorParams, includeParams = true): string {
  return `${SERIES_CATALOG[series].label}${includeParams ? paramsSuffix(series, params) : ''}`;
}

function formatThreshold(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  if (abs >= 10_000) return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
  if (abs >= 1) return Number(value.toFixed(4)).toString();
  return Number(value.toFixed(6)).toString();
}

function rightLabel(right: NumericRef): string {
  if (right.type === 'number') return formatThreshold(right.value);
  return seriesLabel(right.series, right.params);
}

export function describeCondition(condition: Condition): string {
  return `${condition.timeframe} ${seriesLabel(condition.left.series, condition.left.params)} ${
    COMPARATOR_LABEL[condition.cmp]
  } ${rightLabel(condition.right)}`;
}

function describeNode(node: ExpressionNode, parentOp?: 'AND' | 'OR'): string {
  if (node.kind === 'condition') return describeCondition(node);
  const joiner = node.op === 'AND' ? ' 并且 ' : ' 或者 ';
  const text = node.children.map((child) => describeNode(child, node.op)).join(joiner);
  const needsParens = parentOp && parentOp !== node.op;
  return needsParens ? `（${text}）` : text;
}

export function ruleSummary(expression: ExpressionNode): string {
  return `当 ${describeNode(expression)} 时`;
}

export function describeCooldown(seconds: number): string {
  if (seconds === 0) return '无冷却';
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return `${seconds} 秒`;
}
