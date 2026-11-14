import { describe, expect, it } from 'vitest';
import {
  aggregateTone,
  conditionLabel,
  deliveryText,
  deliveryTone,
  formatCompact,
  formatDateTime,
  formatDuration,
  formatLatency,
  formatNumber,
  summarizeExpression,
} from '../../src/web/lib/format';
import { RULE_TEMPLATES, blankDraft, findTemplate } from '../../src/web/lib/templates';
import { parseRuleInput } from '../../src/server/rules/schema';
import type { ConditionGroup } from '../../src/shared/types';

describe('web formatting helpers', () => {
  const t = Date.parse('2026-11-09T15:04:05+08:00');
  it('formats times in Asia/Shanghai', () => {
    expect(formatDateTime(t)).toBe('11-09 15:04:05');
    expect(formatDateTime(t, true, false)).toBe('2026-11-09 15:04');
    expect(formatDateTime(null)).toBe('—');
  });

  it('formats numbers, compact volumes, durations and latency', () => {
    expect(formatNumber(1234.567)).toBe('1,234.57');
    expect(formatNumber(1.23456)).toBe('1.235');
    expect(formatNumber(null)).toBe('—');
    expect(formatCompact(1_500_000)).toBe('1.50M');
    expect(formatCompact(1_500)).toBe('1.5K');
    expect(formatDuration(300)).toBe('5 分钟');
    expect(formatDuration(0)).toBe('无冷却');
    expect(formatDuration(3660)).toBe('1 小时 1 分');
    expect(formatLatency(45)).toBe('45 ms');
    expect(formatLatency(1500)).toBe('1.5 s');
  });

  it('maps statuses to pill tones', () => {
    expect(aggregateTone('satisfied')).toBe('success');
    expect(aggregateTone('degraded')).toBe('warn');
    expect(aggregateTone('warming')).toBe('info');
    expect(aggregateTone('paused')).toBe('off');
    expect(deliveryTone('sent')).toBe('success');
    expect(deliveryTone('dead')).toBe('danger');
    expect(deliveryTone('skipped')).toBe('off');
    expect(deliveryText({ status: 'sent', channel: 'discord' })).toBe('已送达');
    expect(deliveryText({ status: 'sent', channel: 'pushplus' })).toBe('已受理');
    expect(deliveryText(null, '无投递记录')).toBe('无投递记录');
  });

  it('summarizes conditions for the editor', () => {
    const expression: ConditionGroup = {
      kind: 'group',
      op: 'AND',
      children: [
        { kind: 'condition', id: 'a', timeframe: '15m', left: { series: 'bb.midSlope', params: { length: 20, mult: 2, slopeWindow: 1 } }, cmp: 'gt', right: { type: 'number', value: 0 } },
        { kind: 'condition', id: 'b', timeframe: '5m', left: { series: 'price.low' }, cmp: 'lte', right: { type: 'series', series: 'bb.lower', params: { length: 20, mult: 2 } } },
      ],
    };
    const summary = summarizeExpression(expression);
    expect(summary).toContain('15m 中轨斜率');
    expect(summary).toContain('并且');
    expect(summary).toContain('5m 最低价');
    expect(conditionLabel(expression.children[0] as any)).toContain('>');
  });
});

describe('rule templates', () => {
  it('contains all template examples with unique ids and valid server-side schemas', () => {
    expect(RULE_TEMPLATES.length).toBeGreaterThanOrEqual(4);
    const ids = new Set<string>();
    for (const template of RULE_TEMPLATES) {
      const parsed = parseRuleInput(template.draft);
      expect(parsed.ok, `${template.key}: ${parsed.ok ? '' : JSON.stringify(parsed.errors)}`).toBe(true);
      const expression = template.draft.expression as ConditionGroup;
      for (const child of expression.children) {
        if (child.kind === 'condition') {
          expect(ids.has(child.id)).toBe(false);
          ids.add(child.id);
        }
      }
      expect(template.draft.name.length).toBeGreaterThanOrEqual(2);
      expect(template.draft.symbols.length).toBeGreaterThan(0);
    }
  });

  it('builds a blank draft and resolves templates', () => {
    const draft = blankDraft(420);
    expect(draft.cooldownSec).toBe(420);
    expect(draft.enabled).toBe(true);
    expect(draft.expression.kind).toBe('group');
    expect(findTemplate('trend-pullback')?.draft.name).toContain('多头');
    expect(findTemplate('missing')).toBeNull();
  });
});
