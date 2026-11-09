import {
  defaultParamsFor,
  type Comparator,
  type Condition,
  type ConditionGroup,
  type NumericRef,
  type RuleDraft,
  type SeriesKey,
  type Timeframe,
  type TriggerMode,
} from '../../shared/types';

export interface RuleTemplate {
  key: string;
  title: string;
  description: string;
  draft: RuleDraft;
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `c_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

export function condition(
  timeframe: Timeframe,
  series: SeriesKey,
  cmp: Comparator,
  right: NumericRef,
  id = newId(),
): Condition {
  const params = defaultParamsFor(series);
  return {
    kind: 'condition',
    id,
    timeframe,
    left: { series, params },
    cmp,
    right,
  };
}

function seriesRight(series: SeriesKey): NumericRef {
  return { type: 'series', series, params: defaultParamsFor(series) };
}

function group(children: Condition[] , op: 'AND' | 'OR' = 'AND'): ConditionGroup {
  return { kind: 'group', op, children };
}

export function createTemplates(): RuleTemplate[] {
  const common = {
    symbols: ['BTC-USDT-SWAP'],
    triggerMode: 'close' as TriggerMode,
    cooldownSec: 300,
    note: '',
  };
  return [
    {
      key: 'j-high',
      title: 'J 值高位提醒',
      description: '15m KDJ 的 J 值达到 90 时提醒',
      draft: {
        ...common,
        name: '15m KDJ J 高位',
        expression: group([condition('15m', 'kdj.j', 'gte', { type: 'number', value: 90 })]),
      },
    },
    {
      key: 'mid-slope',
      title: '中轨转弱',
      description: '5m 布林中轨斜率变为负值时提醒',
      draft: {
        ...common,
        name: '5m 中轨转弱',
        expression: group([condition('5m', 'bb.midSlope', 'lt', { type: 'number', value: 0 })]),
      },
    },
    {
      key: 'lower-touch',
      title: '下轨触及',
      description: '5m 最低价触及布林带下轨时提醒',
      draft: {
        ...common,
        name: '5m 下轨触及',
        expression: group([condition('5m', 'price.low', 'lte', seriesRight('bb.lower'))]),
      },
    },
    {
      key: 'trend-pullback',
      title: '趋势回踩组合',
      description: '15m 中轨斜率为正，且 5m 价格触及下轨',
      draft: {
        ...common,
        name: '15m 多头 + 5m 下轨回踩',
        expression: group([
          condition('15m', 'bb.midSlope', 'gt', { type: 'number', value: 0 }),
          condition('5m', 'price.low', 'lte', seriesRight('bb.lower')),
        ]),
      },
    },
    {
      key: 'rsi-oversold',
      title: 'RSI 超卖',
      description: '5m RSI 跌到 30 或以下时提醒',
      draft: {
        ...common,
        name: '5m RSI 超卖',
        expression: group([condition('5m', 'rsi.rsi', 'lte', { type: 'number', value: 30 })]),
      },
    },
    {
      key: 'volume-spike',
      title: '量能放大',
      description: '5m 成交量达到 20 周期均量的 1.5 倍',
      draft: {
        ...common,
        name: '5m 量能放大',
        expression: group([condition('5m', 'volume.ratio', 'gte', { type: 'number', value: 1.5 })]),
      },
    },
  ];
}

export const RULE_TEMPLATES = createTemplates();

export function findTemplate(key: string | null): RuleTemplate | null {
  return key ? RULE_TEMPLATES.find((template) => template.key === key) ?? null : null;
}

export function blankDraft(defaultCooldownSec = 300): RuleDraft & { enabled: boolean } {
  return {
    name: '',
    symbols: ['BTC-USDT-SWAP'],
    triggerMode: 'close',
    cooldownSec: defaultCooldownSec,
    note: '',
    enabled: true,
    expression: group([condition('5m', 'price.low', 'lte', seriesRight('bb.lower'))]),
  };
}

export function draftFromTemplate(key: string | null, defaultCooldownSec = 300): RuleDraft & { enabled: boolean } {
  const template = findTemplate(key);
  if (!template) return blankDraft(defaultCooldownSec);
  return {
    ...template.draft,
    cooldownSec: template.draft.cooldownSec || defaultCooldownSec,
    symbols: [...template.draft.symbols],
    expression: JSON.parse(JSON.stringify(template.draft.expression)),
    enabled: true,
  };
}

export function newCondition(timeframe: Timeframe = '5m'): Condition {
  return condition(timeframe, 'price.low', 'lte', seriesRight('bb.lower'));
}

export function newGroup(): ConditionGroup {
  return { kind: 'group', op: 'AND', children: [newCondition()] };
}

export function defaultThresholdFor(series: SeriesKey): number {
  if (series === 'kdj.j' || series === 'kdj.k') return 90;
  if (series === 'rsi.rsi') return 30;
  if (series === 'volume.ratio') return 1.5;
  return 0;
}

export function defaultRightSeriesFor(left: SeriesKey): SeriesKey {
  if (left.startsWith('price.')) return left === 'price.low' ? 'bb.lower' : left === 'price.high' ? 'bb.upper' : 'bb.middle';
  if (left.startsWith('bb.')) return 'price.close';
  return 'price.close';
}
