import type { Rule, RuleState, RuleView, AggregateRuleStatus, RuleStateView, Timeframe } from '../../shared/types';
import { AGGREGATE_STATUS_LABEL } from '../../shared/types';
import type { Store } from '../store';
import type { RuleEngine } from './engine';
import { collectTimeframes, flattenConditions } from './schema';
import { ruleSummary } from './summary';

const STATUS_LABEL: Record<RuleState['status'], string> = {
  paused: '已暂停',
  warming: '预热中',
  armed: '监控中',
  satisfied: '已满足',
  degraded: '数据异常',
};

export function aggregateRuleStatus(rule: Rule, states: RuleState[]): AggregateRuleStatus {
  if (!rule.enabled) return 'paused';
  if (!states.length) return 'warming';
  if (states.some((state) => state.status === 'degraded')) return 'degraded';
  if (states.some((state) => state.status === 'warming' || state.status === 'paused')) return 'warming';
  if (states.every((state) => state.status === 'satisfied')) return 'satisfied';
  return 'armed';
}

export function toRuleView(rule: Rule, store: Store, engine: RuleEngine, now = Date.now()): RuleView {
  const engineStates = rule.enabled ? engine.getStatesForRule(rule.id) : [];
  const states: RuleState[] = engineStates.length
    ? engineStates.map((state) => ({
        ruleId: state.ruleId,
        symbol: state.symbol,
        ruleVersion: state.ruleVersion,
        lastTruth: state.lastTruth,
        lastEvalAt: state.lastEvalAt,
        lastEvalBarClose: state.lastEvalBarClose,
        lastTriggerAt: state.lastTriggerAt,
        status: state.status,
        detail: state.detail,
      }))
    : rule.enabled
      ? rule.symbols.map((symbol) => ({
          ruleId: rule.id,
          symbol,
          ruleVersion: rule.version,
          lastTruth: null,
          lastEvalAt: null,
          lastEvalBarClose: null,
          lastTriggerAt: null,
          status: 'warming' as const,
          detail: null,
        }))
      : [];
  const status = aggregateRuleStatus(rule, states);
  const stateViews: RuleStateView[] = states.map((state) => ({
    ...state,
    statusLabel: STATUS_LABEL[state.status],
  }));
  const triggers = engineStates
    .map((state) => state.lastTriggerAt)
    .filter((value): value is number => typeof value === 'number');
  const persistedLastTrigger = store.lastTriggerForRule(rule.id);
  if (persistedLastTrigger !== null) triggers.push(persistedLastTrigger);
  return {
    ...rule,
    summary: ruleSummary(rule.expression),
    ruleStatus: status,
    statusLabel: AGGREGATE_STATUS_LABEL[status],
    states: stateViews,
    lastTriggerAt: triggers.length ? Math.max(...triggers) : null,
    triggerCount24h: store.countEventsForRuleSince(rule.id, now - 86_400_000),
    timeframes: collectTimeframes(rule.expression),
  };
}

export function ruleNeedsPair(rule: Rule, symbol: string, timeframe: Timeframe): boolean {
  return rule.symbols.includes(symbol) && collectTimeframes(rule.expression).includes(timeframe);
}

export function conditionCount(rule: Rule): number {
  return flattenConditions(rule.expression).length;
}
