import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  type ConditionEvaluation,
  type ExpressionNode,
  type Rule,
  type RuleEvaluation,
  type RuleStateStatus,
  type Timeframe,
  type NotificationChannel,
  MAX_ALERT_GRACE_MS,
} from '../../shared/types';
import type { Store } from '../store';
import type { MarketDataProvider, PairRef } from '../market/provider';
import { pairKey } from '../market/provider';
import { evaluateRule, type EvaluationOutcome } from './evaluator';
import { collectTimeframes, flattenConditions } from './schema';

interface ManagedState {
  ruleId: string;
  symbol: string;
  ruleVersion: number;
  lastTruth: boolean | null;
  lastEvalAt: number | null;
  lastEvalBarClose: number | null;
  lastTriggerAt: number | null;
  status: RuleStateStatus;
  detail: Record<string, unknown> | null;
  needsBaseline: boolean;
}

interface ScheduledEvaluation {
  timer: NodeJS.Timeout;
  source: 'closed' | 'tick' | 'baseline';
}

export interface EngineOptions {
  store: Store;
  market: MarketDataProvider;
  /** Backward-compatible alias for older tests/embedders. */
  isWebhookConfigured?: () => boolean;
  isNotificationConfigured?: () => boolean;
  getNotificationChannel?: () => NotificationChannel;
  settleMs?: number;
  tickThrottleMs?: number;
  baselineDelayMs?: number;
}

export class RuleEngine extends EventEmitter {
  private store: Store;
  private market: MarketDataProvider;
  private isNotificationConfigured: () => boolean;
  private getNotificationChannel: () => NotificationChannel;
  private rules = new Map<string, Rule>();
  private ruleSignatures = new Map<string, string>();
  private states = new Map<string, ManagedState>();
  private scheduled = new Map<string, ScheduledEvaluation>();
  private settleMs: number;
  private tickThrottleMs: number;
  private baselineDelayMs: number;
  private started = false;

  constructor(options: EngineOptions) {
    super();
    this.store = options.store;
    this.market = options.market;
    this.isNotificationConfigured =
      options.isNotificationConfigured ?? options.isWebhookConfigured ?? (() => false);
    this.getNotificationChannel = options.getNotificationChannel ?? (() => 'discord');
    this.settleMs = options.settleMs ?? 2200;
    this.tickThrottleMs = options.tickThrottleMs ?? 300;
    this.baselineDelayMs = options.baselineDelayMs ?? 250;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.market.on('closed', this.onClosedBar);
    this.market.on('tick', this.onTick);
    this.market.on('ready', this.onPairReady);
    this.market.on('resync', this.onResync);
    this.market.on('status', this.onMarketStatus);
    this.market.on('marketError', this.onMarketError);
    this.reloadRules();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.market.off('closed', this.onClosedBar);
    this.market.off('tick', this.onTick);
    this.market.off('ready', this.onPairReady);
    this.market.off('resync', this.onResync);
    this.market.off('status', this.onMarketStatus);
    this.market.off('marketError', this.onMarketError);
    for (const scheduled of this.scheduled.values()) clearTimeout(scheduled.timer);
    this.scheduled.clear();
  }

  getRule(ruleId: string): Rule | null {
    return this.rules.get(ruleId) ?? null;
  }

  listActiveRules(): Rule[] {
    return [...this.rules.values()];
  }

  getState(ruleId: string, symbol: string): ManagedState | null {
    return this.states.get(`${ruleId}|${symbol}`) ?? null;
  }

  getStatesForRule(ruleId: string): ManagedState[] {
    return [...this.states.values()].filter((state) => state.ruleId === ruleId);
  }

  /**
   * Reload enabled rules from SQLite. New/edited rules are placed into baseline mode:
   * their first successful evaluation establishes truth but never sends a notification.
   */
  reloadRules(): void {
    const previousRules = new Map(this.rules);
    const enabledRules = this.store.listEnabledRules();
    const nextRules = new Map<string, Rule>();
    for (const rule of enabledRules) nextRules.set(rule.id, rule);
    this.rules = nextRules;

    for (const [ruleId, previous] of previousRules) {
      if (!nextRules.has(ruleId)) {
        this.removeRuleStates(ruleId);
        this.clearTimersForRule(ruleId);
      }
      void previous;
    }

    for (const rule of enabledRules) {
      const signature = `${rule.version}:${rule.updatedAt}:${rule.enabled}`;
      const changed = this.ruleSignatures.get(rule.id) !== signature;
      if (changed) {
        this.resetRuleStates(rule);
        this.ruleSignatures.set(rule.id, signature);
      }
      this.ensureStates(rule);
    }

    for (const [ruleId] of this.ruleSignatures) {
      if (!nextRules.has(ruleId)) this.ruleSignatures.delete(ruleId);
    }

    this.emit('rulesChanged', this.listActiveRules());
    void this.refreshSubscriptions();
  }

  private resetRuleStates(rule: Rule): void {
    this.clearTimersForRule(rule.id);
    const lastTriggers = new Map<string, number | null>();
    for (const symbol of rule.symbols) {
      lastTriggers.set(symbol, this.store.getRuleState(rule.id, symbol)?.lastTriggerAt ?? null);
    }
    this.store.deleteRuleStates(rule.id);
    for (const state of [...this.states.values()]) {
      if (state.ruleId === rule.id) this.states.delete(`${state.ruleId}|${state.symbol}`);
    }
    for (const symbol of rule.symbols) {
      const state: ManagedState = {
        ruleId: rule.id,
        symbol,
        ruleVersion: rule.version,
        lastTruth: null,
        lastEvalAt: null,
        lastEvalBarClose: null,
        lastTriggerAt: lastTriggers.get(symbol) ?? null,
        status: 'warming',
        detail: null,
        needsBaseline: true,
      };
      this.states.set(`${rule.id}|${symbol}`, state);
      this.persistState(state);
      this.emit('stateChanged', { ruleId: rule.id, symbol, state: this.publicState(state) });
    }
  }

  private ensureStates(rule: Rule): void {
    const desired = new Set(rule.symbols);
    for (const [key, state] of [...this.states]) {
      if (state.ruleId === rule.id && !desired.has(state.symbol)) {
        this.states.delete(key);
        this.store.deleteRuleStates(rule.id);
        for (const remaining of this.getStatesForRule(rule.id)) this.persistState(remaining);
      }
    }
    for (const symbol of rule.symbols) {
      const key = `${rule.id}|${symbol}`;
      if (!this.states.has(key)) {
        const state: ManagedState = {
          ruleId: rule.id,
          symbol,
          ruleVersion: rule.version,
          lastTruth: null,
          lastEvalAt: null,
          lastEvalBarClose: null,
          lastTriggerAt: this.store.getRuleState(rule.id, symbol)?.lastTriggerAt ?? null,
          status: 'warming',
          detail: null,
          needsBaseline: true,
        };
        this.states.set(key, state);
        this.persistState(state);
        this.emit('stateChanged', { ruleId: rule.id, symbol, state: this.publicState(state) });
      }
    }
  }

  private removeRuleStates(ruleId: string): void {
    for (const [key, state] of [...this.states]) {
      if (state.ruleId === ruleId) this.states.delete(key);
    }
    this.store.deleteRuleStates(ruleId);
  }

  private async refreshSubscriptions(): Promise<void> {
    const pairs: PairRef[] = [];
    const seen = new Set<string>();
    for (const rule of this.rules.values()) {
      for (const symbol of rule.symbols) {
        for (const timeframe of collectTimeframes(rule.expression)) {
          const key = pairKey(symbol, timeframe);
          if (!seen.has(key)) {
            seen.add(key);
            pairs.push({ instId: symbol, timeframe });
          }
        }
      }
    }
    try {
      await this.market.ensurePairs(pairs);
      this.scheduleAllBaselines();
    } catch (error) {
      this.emit('diagnosticError', error instanceof Error ? error.message : String(error));
    }
  }

  private scheduleAllBaselines(): void {
    for (const state of this.states.values()) {
      if (state.needsBaseline) this.schedule(state.ruleId, state.symbol, this.baselineDelayMs, 'baseline');
    }
  }

  private onClosedBar = (candle: import('../../shared/types').Candle): void => {
    for (const rule of this.rules.values()) {
      if (!rule.symbols.includes(candle.instId)) continue;
      if (!collectTimeframes(rule.expression).includes(candle.timeframe)) continue;
      const state = this.states.get(`${rule.id}|${candle.instId}`);
      if (!state) continue;
      this.schedule(rule.id, candle.instId, this.settleMs, 'closed');
    }
  };

  private onTick = (candle: import('../../shared/types').Candle): void => {
    for (const rule of this.rules.values()) {
      if (rule.triggerMode !== 'intrabar') continue;
      if (!rule.symbols.includes(candle.instId)) continue;
      if (!collectTimeframes(rule.expression).includes(candle.timeframe)) continue;
      const existing = this.scheduled.get(`${rule.id}|${candle.instId}`);
      if (existing && existing.source === 'closed') continue;
      this.schedule(rule.id, candle.instId, this.tickThrottleMs, 'tick');
    }
  };

  private onPairReady = (pair: PairRef): void => {
    for (const rule of this.rules.values()) {
      if (!rule.symbols.includes(pair.instId)) continue;
      if (!collectTimeframes(rule.expression).includes(pair.timeframe)) continue;
      const state = this.states.get(`${rule.id}|${pair.instId}`);
      if (state?.needsBaseline) this.schedule(rule.id, pair.instId, this.baselineDelayMs, 'baseline');
    }
  };

  private onResync = (pairs: PairRef[]): void => {
    const affected = new Set(pairs.map((pair) => pairKey(pair.instId, pair.timeframe)));
    for (const rule of this.rules.values()) {
      for (const symbol of rule.symbols) {
        const frames = collectTimeframes(rule.expression);
        if (!frames.some((tf) => affected.has(pairKey(symbol, tf)))) continue;
        const state = this.states.get(`${rule.id}|${symbol}`);
        if (!state) continue;
        state.needsBaseline = true;
        state.lastTruth = null;
        state.status = 'warming';
        state.detail = { reason: '数据源重连，重建基线', at: Date.now() };
        this.persistState(state);
        this.emit('stateChanged', { ruleId: rule.id, symbol, state: this.publicState(state) });
        this.schedule(rule.id, symbol, this.baselineDelayMs, 'baseline');
      }
    }
  };

  private onMarketStatus = (pairs: import('../../shared/types').MarketPairStatus[]): void => {
    this.emit('marketStatus', pairs);
  };

  private onMarketError = (error: Error): void => {
    this.emit('diagnosticError', error.message);
  };

  private schedule(ruleId: string, symbol: string, delay: number, source: 'closed' | 'tick' | 'baseline'): void {
    const key = `${ruleId}|${symbol}`;
    const previous = this.scheduled.get(key);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => {
      this.scheduled.delete(key);
      this.evaluateOne(ruleId, symbol, source);
    }, Math.max(0, delay));
    timer.unref?.();
    this.scheduled.set(key, { timer, source });
  }

  private clearTimersForRule(ruleId: string): void {
    for (const [key, scheduled] of [...this.scheduled]) {
      if (!key.startsWith(`${ruleId}|`)) continue;
      clearTimeout(scheduled.timer);
      this.scheduled.delete(key);
    }
  }

  /** Evaluate all current rule/symbol states immediately. Exposed for deterministic tests. */
  flush(): void {
    const keys = [...this.scheduled.entries()];
    this.scheduled.clear();
    for (const [key, scheduled] of keys) {
      clearTimeout(scheduled.timer);
      const [ruleId, symbol] = key.split('|');
      this.evaluateOne(ruleId, symbol, scheduled.source);
    }
  }

  evaluateNow(ruleId: string, symbol: string, source: 'closed' | 'tick' | 'baseline' = 'closed'): void {
    const key = `${ruleId}|${symbol}`;
    const scheduled = this.scheduled.get(key);
    if (scheduled) {
      clearTimeout(scheduled.timer);
      this.scheduled.delete(key);
    }
    this.evaluateOne(ruleId, symbol, source);
  }

  private evaluateOne(ruleId: string, symbol: string, source: 'closed' | 'tick' | 'baseline'): void {
    const rule = this.rules.get(ruleId);
    const state = this.states.get(`${ruleId}|${symbol}`);
    if (!rule || !state) return;
    if (rule.triggerMode === 'close' && source === 'tick') return;
    const now = this.market.exchangeNow();
    let outcome: EvaluationOutcome;
    try {
      outcome = evaluateRule(rule, symbol, this.market, now, source === 'closed');
    } catch (error) {
      this.markDegraded(state, error instanceof Error ? error.message : String(error));
      return;
    }

    if (!outcome.ok) {
      if (state.needsBaseline && outcome.reason === 'history') {
        state.status = 'warming';
        state.detail = { reason: outcome.message, at: now };
        this.persistState(state);
        this.emit('stateChanged', { ruleId, symbol, state: this.publicState(state) });
        return;
      }
      if (state.needsBaseline && outcome.reason === 'stale') {
        state.status = 'warming';
        state.detail = { reason: outcome.message, at: now };
        this.persistState(state);
        this.emit('stateChanged', { ruleId, symbol, state: this.publicState(state) });
        return;
      }
      this.markDegraded(state, outcome.message, now);
      return;
    }

    const evaluation = outcome.evaluation;
    this.applyEvaluation(rule, state, evaluation, now, source);
  }

  private markDegraded(state: ManagedState, message: string, now = Date.now()): void {
    state.status = 'degraded';
    state.needsBaseline = true;
    state.lastTruth = null;
    state.detail = { reason: message, at: now };
    state.lastEvalAt = now;
    this.persistState(state);
    this.emit('stateChanged', { ruleId: state.ruleId, symbol: state.symbol, state: this.publicState(state) });
  }

  private applyEvaluation(
    rule: Rule,
    state: ManagedState,
    evaluation: RuleEvaluation,
    now: number,
    source: 'closed' | 'tick' | 'baseline',
  ): void {
    const previousTruth = state.lastTruth;
    const barClose = Math.max(...evaluation.conditions.map((condition) => condition.barCloseTime));
    const detail = {
      conditions: evaluation.conditions,
      truth: evaluation.truth,
      price: evaluation.price,
      triggerBarTs: evaluation.triggerBarTs,
      triggerBarCloseTs: evaluation.triggerBarCloseTs,
      asOf: now,
      mode: rule.triggerMode,
      source,
    };

    if (state.needsBaseline) {
      state.lastTruth = evaluation.truth;
      state.needsBaseline = false;
      state.lastEvalAt = now;
      state.lastEvalBarClose = barClose;
      state.status = evaluation.truth ? 'satisfied' : 'armed';
      state.detail = detail;
      this.persistState(state);
      this.emit('stateChanged', { ruleId: rule.id, symbol: state.symbol, state: this.publicState(state) });
      return;
    }

    if (rule.triggerMode === 'intrabar' && source === 'closed') {
      this.updateCloseConfirmation(rule, state, evaluation);
    }

    let triggered = false;
    if (!previousTruth && evaluation.truth) {
      const cooldownMs = rule.cooldownSec * 1000;
      const cooling = state.lastTriggerAt !== null && now - state.lastTriggerAt < cooldownMs;
      const tooLate =
        source !== 'tick' &&
        barClose > 0 &&
        now - barClose > MAX_ALERT_GRACE_MS;
      if (!cooling && !tooLate) {
        triggered = this.createEvent(rule, state, evaluation, now);
      } else if (tooLate) {
        this.emit('missedTrigger', { ruleId: rule.id, symbol: state.symbol, barClose, reason: 'late' });
      }
      if (cooling) {
        this.emit('cooldownSuppressed', { ruleId: rule.id, symbol: state.symbol });
      }
    }

    state.lastTruth = evaluation.truth;
    state.needsBaseline = false;
    state.lastEvalAt = now;
    state.lastEvalBarClose = barClose;
    state.status = evaluation.truth ? 'satisfied' : 'armed';
    state.detail = detail;
    if (triggered) {
      // lastTriggerAt is updated inside createEvent; reload state to include it.
      const fresh = this.store.getRuleState(rule.id, state.symbol);
      if (fresh?.lastTriggerAt) state.lastTriggerAt = fresh.lastTriggerAt;
    }
    this.persistState(state);
    this.emit('stateChanged', { ruleId: rule.id, symbol: state.symbol, state: this.publicState(state) });
  }

  private updateCloseConfirmation(rule: Rule, state: ManagedState, evaluation: RuleEvaluation): void {
    if (evaluation.triggerBarTs === null) return;
    const existing = this.store.getEventByUnique(rule.id, state.symbol, evaluation.triggerBarTs);
    if (!existing || existing.closeConfirmed !== null) return;
    this.store.updateCloseConfirmation(rule.id, state.symbol, evaluation.triggerBarTs, evaluation.truth);
  }

  private createEvent(rule: Rule, state: ManagedState, evaluation: RuleEvaluation, now: number): boolean {
    if (evaluation.triggerBarTs === null || evaluation.price === null) return false;
    const triggerAt = rule.triggerMode === 'close' ? (evaluation.triggerBarCloseTs ?? now) : now;
    const eventId = randomUUID();
    const notificationConfigured = this.isNotificationConfigured();
    const notificationChannel = this.getNotificationChannel();
    const event = {
      id: eventId,
      ruleId: rule.id,
      ruleName: rule.name,
      ruleVersion: rule.version,
      symbol: state.symbol,
      triggerMode: rule.triggerMode,
      triggerBarTs: evaluation.triggerBarTs,
      triggerBarCloseTs: evaluation.triggerBarCloseTs ?? evaluation.triggerBarTs,
      triggerAt,
      price: evaluation.price,
      expression: rule.expression,
      conditions: evaluation.conditions,
      note: rule.note ?? '',
      closeConfirmed:
        rule.triggerMode === 'close'
          ? true
          : evaluation.triggerBarCloseTs !== null && evaluation.triggerBarCloseTs <= now
            ? true
            : null,
    } as const;
    const delivery = notificationConfigured
      ? { status: 'pending' as const, channel: notificationChannel, nextAttemptAt: null }
      : {
          status: 'skipped' as const,
          channel: notificationChannel,
          error: notificationChannel === 'pushplus' ? '未配置 PushPlus Token' : '未配置 Discord Webhook',
          nextAttemptAt: null,
        };
    let inserted = false;
    this.store.transaction(() => {
      const result = this.store.insertEventIfNew(event, delivery);
      inserted = result.inserted;
      if (!inserted) return;
      state.lastTriggerAt = now;
      this.store.upsertRuleState({
        ruleId: rule.id,
        symbol: state.symbol,
        ruleVersion: rule.version,
        lastTruth: true,
        lastEvalAt: now,
        lastEvalBarClose: evaluation.triggerBarCloseTs ?? null,
        lastTriggerAt: now,
        status: 'satisfied',
        detail: null,
      });
    });
    if (inserted) {
      const view = this.store.getEvent(eventId);
      if (view) this.emit('triggered', view);
    }
    return inserted;
  }

  private persistState(state: ManagedState): void {
    this.store.upsertRuleState({
      ruleId: state.ruleId,
      symbol: state.symbol,
      ruleVersion: state.ruleVersion,
      lastTruth: state.lastTruth,
      lastEvalAt: state.lastEvalAt,
      lastEvalBarClose: state.lastEvalBarClose,
      lastTriggerAt: state.lastTriggerAt,
      status: state.status,
      detail: state.detail,
    });
  }

  private publicState(state: ManagedState): Record<string, unknown> {
    return {
      ruleId: state.ruleId,
      symbol: state.symbol,
      ruleVersion: state.ruleVersion,
      lastTruth: state.lastTruth,
      lastEvalAt: state.lastEvalAt,
      lastEvalBarClose: state.lastEvalBarClose,
      lastTriggerAt: state.lastTriggerAt,
      status: state.status,
      detail: state.detail,
    };
  }

  previewRule(rule: Rule): { symbol: string; ok: boolean; evaluation?: RuleEvaluation; reason?: string; message?: string }[] {
    return rule.symbols.map((symbol) => {
      const outcome = evaluateRule(rule, symbol, this.market, this.market.exchangeNow());
      return outcome.ok
        ? { symbol, ok: true, evaluation: outcome.evaluation }
        : { symbol, ok: false, reason: outcome.reason, message: outcome.message };
    });
  }
}

export function expressionTimeframes(expression: ExpressionNode): Timeframe[] {
  return collectTimeframes(expression);
}

export function conditionSnapshots(expression: ExpressionNode): { count: number; ids: string[] } {
  const conditions = flattenConditions(expression);
  return { count: conditions.length, ids: conditions.map((condition) => condition.id) };
}
