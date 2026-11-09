import {
  COMPARATORS,
  type Comparator,
  MAX_CONDITIONS,
  MAX_GROUP_DEPTH,
  SERIES_CATALOG,
  type Condition,
  type ConditionGroup,
  type ExpressionNode,
  type IndicatorParams,
  type NumericRef,
  type RuleDraft,
  type SeriesKey,
  type Timeframe,
  TIMEFRAMES,
  TRIGGER_MODES,
  defaultParamsFor,
  normalizeParams,
} from '../../shared/types';

export interface ValidationIssue {
  code: string;
  message: string;
  conditionId?: string;
}

export interface ParsedRule {
  draft: RuleDraft;
  warnings: ValidationIssue[];
}

export type ParseResult = { ok: true; value: ParsedRule } | { ok: false; errors: ValidationIssue[] };

const DEFAULT_PARAM_RANGES: Record<string, [number, number, boolean]> = {
  length: [2, 500, true],
  mult: [0.1, 10, false],
  slopeWindow: [1, 50, true],
  kSmooth: [1, 20, true],
  dSmooth: [1, 20, true],
  fast: [2, 100, true],
  slow: [2, 200, true],
  signal: [2, 100, true],
  maLength: [1, 500, true],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validSymbol(symbol: string): boolean {
  return /^[A-Z0-9][A-Z0-9._-]{1,39}$/.test(symbol);
}

function validateParams(
  series: SeriesKey,
  raw: unknown,
  conditionId: string,
  errors: ValidationIssue[],
): IndicatorParams {
  const defaults = defaultParamsFor(series);
  if (raw === undefined) return defaults;
  if (!isRecord(raw)) {
    errors.push({ code: 'params.invalid', message: '指标参数必须是对象', conditionId });
    return defaults;
  }
  const normalized = normalizeParams(series, raw as IndicatorParams);
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in defaults)) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push({ code: 'params.type', message: `参数 ${key} 必须是有限数值`, conditionId });
      continue;
    }
    const range = DEFAULT_PARAM_RANGES[key];
    if (range) {
      const [min, max, integer] = range;
      if (value < min || value > max || (integer && !Number.isInteger(value))) {
        errors.push({
          code: 'params.range',
          message: `参数 ${key} 必须在 ${min}–${max}${integer ? ' 的整数' : ''} 范围内`,
          conditionId,
        });
      }
    }
  }
  if (SeriesParamKind(series) === 'macd') {
    const fast = normalized.fast ?? 12;
    const slow = normalized.slow ?? 26;
    if (fast >= slow) {
      errors.push({ code: 'params.macd', message: 'MACD 快线周期必须小于慢线周期', conditionId });
    }
  }
  return normalized;
}

function SeriesParamKind(series: SeriesKey): string | undefined {
  return SERIES_CATALOG[series]?.paramsKind;
}

function parseSeriesRef(raw: unknown, conditionId: string, errors: ValidationIssue[]): { series: SeriesKey; params: IndicatorParams } | null {
  if (!isRecord(raw) || typeof raw.series !== 'string') {
    errors.push({ code: 'series.missing', message: '条件缺少指标序列', conditionId });
    return null;
  }
  if (!(raw.series in SERIES_CATALOG)) {
    errors.push({ code: 'series.unknown', message: `未知指标序列：${raw.series}`, conditionId });
    return null;
  }
  const series = raw.series as SeriesKey;
  const params = validateParams(series, raw.params, conditionId, errors);
  return { series, params };
}

function parseCondition(raw: unknown, conditionId: string, errors: ValidationIssue[]): Condition | null {
  if (!isRecord(raw)) {
    errors.push({ code: 'condition.invalid', message: '条件格式错误', conditionId });
    return null;
  }
  if (!TIMEFRAMES.includes(raw.timeframe as Timeframe)) {
    errors.push({ code: 'timeframe.invalid', message: '条件的时间周期不合法', conditionId });
  }
  if (!COMPARATORS.includes(raw.cmp as Comparator)) {
    errors.push({ code: 'cmp.invalid', message: '比较符不合法', conditionId });
  }
  const left = parseSeriesRef(raw.left, conditionId, errors);
  if (!left) return null;

  let right: NumericRef | null = null;
  if (!isRecord(raw.right)) {
    errors.push({ code: 'right.missing', message: '条件缺少阈值或右侧指标', conditionId });
  } else if (raw.right.type === 'number') {
    const value = raw.right.value;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push({ code: 'right.number', message: '比较值必须是有限数字', conditionId });
    } else {
      right = { type: 'number', value };
    }
  } else if (raw.right.type === 'series') {
    const rightRef = parseSeriesRef({ series: raw.right.series, params: raw.right.params }, conditionId, errors);
    if (rightRef) right = { type: 'series', ...rightRef };
  } else {
    errors.push({ code: 'right.type', message: '右侧类型必须是数值或指标', conditionId });
  }

  if (!left || !right) return null;
  return {
    kind: 'condition',
    id: conditionId,
    timeframe: raw.timeframe as Timeframe,
    left: { series: left.series, params: left.params },
    cmp: raw.cmp as Comparator,
    right,
  };
}

function parseExpression(
  raw: unknown,
  depth: number,
  errors: ValidationIssue[],
  state: { count: number; ids: Set<string>; nextId: number },
): ExpressionNode | null {
  if (!isRecord(raw)) {
    errors.push({ code: 'expression.invalid', message: '规则表达式格式错误' });
    return null;
  }
  if (raw.kind === 'group') {
    if (depth > MAX_GROUP_DEPTH) {
      errors.push({ code: 'expression.depth', message: `条件组最多嵌套 ${MAX_GROUP_DEPTH} 层` });
      return null;
    }
    if (raw.op !== 'AND' && raw.op !== 'OR') {
      errors.push({ code: 'expression.op', message: '条件组必须使用 AND 或 OR' });
      return null;
    }
    if (!Array.isArray(raw.children) || raw.children.length === 0) {
      errors.push({ code: 'expression.empty', message: '条件组至少需要一个条件' });
      return null;
    }
    const children: ExpressionNode[] = [];
    for (const child of raw.children) {
      const parsed = parseExpression(child, depth + 1, errors, state);
      if (parsed) children.push(parsed);
    }
    if (!children.length) return null;
    const group: ConditionGroup = { kind: 'group', op: raw.op, children };
    return group;
  }

  if (raw.kind !== 'condition') {
    errors.push({ code: 'expression.kind', message: '表达式节点类型不合法' });
    return null;
  }
  state.count += 1;
  if (state.count > MAX_CONDITIONS) {
    errors.push({ code: 'expression.count', message: `最多支持 ${MAX_CONDITIONS} 个条件` });
    return null;
  }
  let conditionId = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 80) : '';
  if (!conditionId) conditionId = `c${state.nextId++}`;
  while (state.ids.has(conditionId)) conditionId = `c${state.nextId++}`;
  state.ids.add(conditionId);
  return parseCondition(raw, conditionId, errors);
}

function unitGroup(unit: string): string {
  if (unit === 'price' || unit === 'momentum') return 'price';
  if (unit === 'points') return 'points';
  if (unit === 'percent' || unit === 'percentPerBar') return 'percent';
  return unit;
}

function collectWarnings(expression: ExpressionNode, errors: ValidationIssue[]): ValidationIssue[] {
  const warnings: ValidationIssue[] = [];
  if (errors.length) return warnings;
  const walk = (node: ExpressionNode) => {
    if (node.kind === 'group') {
      node.children.forEach(walk);
      return;
    }
    const leftMeta = SERIES_CATALOG[node.left.series];
    if (node.right.type === 'series') {
      const rightMeta = SERIES_CATALOG[node.right.series];
      if (unitGroup(leftMeta.unit) !== unitGroup(rightMeta.unit)) {
        warnings.push({
          code: 'units.mismatch',
          message: `条件 ${node.id} 左右两侧单位不同（${leftMeta.label} vs ${rightMeta.label}），请确认口径`,
          conditionId: node.id,
        });
      }
    } else {
      const value = node.right.value;
      if (leftMeta.unit === 'points' && (value < 0 || value > 100)) {
        warnings.push({
          code: 'threshold.points',
          message: `条件 ${node.id} 的阈值 ${value} 超出常见 0–100 指标范围`,
          conditionId: node.id,
        });
      }
      if (leftMeta.unit === 'ratio' && value < 0) {
        warnings.push({
          code: 'threshold.ratio',
          message: `条件 ${node.id} 的阈值不能为负数`,
          conditionId: node.id,
        });
      }
    }
  };
  walk(expression);
  return warnings;
}

export function parseRuleInput(raw: unknown): ParseResult {
  const errors: ValidationIssue[] = [];
  if (!isRecord(raw)) {
    return { ok: false, errors: [{ code: 'rule.invalid', message: '请求体必须是对象' }] };
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name.length < 2 || name.length > 40) {
    errors.push({ code: 'name.length', message: '规则名称需为 2–40 个字符' });
  }
  const symbolsRaw = raw.symbols;
  if (!Array.isArray(symbolsRaw) || symbolsRaw.length === 0) {
    errors.push({ code: 'symbols.empty', message: '至少选择一个交易品种' });
  }
  const symbols = Array.isArray(symbolsRaw)
    ? [...new Set(symbolsRaw.filter((s): s is string => typeof s === 'string').map((s) => s.trim().toUpperCase()))]
    : [];
  if (symbols.length > 10) errors.push({ code: 'symbols.count', message: '单条规则最多选择 10 个品种' });
  for (const symbol of symbols) {
    if (!validSymbol(symbol)) errors.push({ code: 'symbols.format', message: `品种格式不合法：${symbol}` });
  }
  if (!TRIGGER_MODES.includes(raw.triggerMode as (typeof TRIGGER_MODES)[number])) {
    errors.push({ code: 'triggerMode.invalid', message: '触发模式不合法' });
  }
  const cooldownSec = raw.cooldownSec;
  if (
    typeof cooldownSec !== 'number' ||
    !Number.isInteger(cooldownSec) ||
    cooldownSec < 0 ||
    cooldownSec > 86_400
  ) {
    errors.push({ code: 'cooldown.invalid', message: '冷却时间必须是 0–1440 分钟的整数' });
  }
  const note = typeof raw.note === 'string' ? raw.note.trim() : '';
  if (note.length > 200) errors.push({ code: 'note.length', message: '备注最多 200 个字符' });

  const state = { count: 0, ids: new Set<string>(), nextId: 1 };
  const expression = parseExpression(raw.expression, 1, errors, state);
  if (!expression) errors.push({ code: 'expression.missing', message: '规则必须包含至少一个条件' });

  if (errors.length || !expression) return { ok: false, errors };
  const draft: RuleDraft = {
    name,
    symbols,
    triggerMode: raw.triggerMode as RuleDraft['triggerMode'],
    cooldownSec: cooldownSec as number,
    expression,
    note,
  };
  return { ok: true, value: { draft, warnings: collectWarnings(expression, errors) } };
}

export function flattenConditions(node: ExpressionNode): Condition[] {
  if (node.kind === 'condition') return [node];
  return node.children.flatMap(flattenConditions);
}

export function collectTimeframes(expression: ExpressionNode): Timeframe[] {
  const set = new Set<Timeframe>();
  for (const condition of flattenConditions(expression)) set.add(condition.timeframe);
  return TIMEFRAMES.filter((tf) => set.has(tf));
}

export function shortestTimeframe(expression: ExpressionNode): Timeframe {
  const order = new Map(TIMEFRAMES.map((tf, i) => [tf, i]));
  const frames = collectTimeframes(expression);
  return frames.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))[0] ?? '5m';
}

export function evaluateExpression(node: ExpressionNode, truthById: Map<string, boolean>): boolean {
  if (node.kind === 'condition') return Boolean(truthById.get(node.id));
  if (node.op === 'AND') return node.children.every((child) => evaluateExpression(child, truthById));
  return node.children.some((child) => evaluateExpression(child, truthById));
}
