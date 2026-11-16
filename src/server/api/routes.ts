import type { FastifyInstance, FastifyReply } from 'fastify';
import type { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import {
  type Candle,
  type ConditionEvaluation,
  type EventView,
  type Rule,
  type RuleDraft,
  type PositionCalculatorConfig,
  TF_MS,
  TIMEFRAMES,
  MIN_HISTORY_BARS,
  normalizeParams,
  type Timeframe,
} from '../../shared/types';
import { exchangeDayStartUtc8, type AppConfig } from '../config';
import type { Store } from '../store';
import type { SettingsService } from '../settings';
import { validateDiscordWebhook, validatePushplusToken } from '../settings';
import { validateProxyUrl } from '../network';
import type { AppMarket } from '../market/provider';
import type { RuleEngine } from '../rules/engine';
import type { DeliveryWorker } from '../alerts/worker';
import type { DiscordClient } from '../alerts/discord';
import type { PushplusClient } from '../alerts/pushplus';
import { parseRuleInput } from '../rules/schema';
import { ruleSummary } from '../rules/summary';
import { toRuleView } from '../rules/service';
import { runTrial, TrialError } from '../trial';
import { calculatePositions, PositionCalcError, validatePositionConfig } from '../positionCalculator';
import { computeSeries } from '../indicators';
import { HistoryError, loadLocalFirstHistory } from '../history';
import { normalizeReplayPeriod, ReplayPeriodError } from '../replayPeriod';
import {
  estimateReplayBars,
  estimateReplaySeconds,
  MAX_REPLAY_BARS_PER_TIMEFRAME,
  startReplayJob,
  type ReplayExecutionParams,
} from '../replayJob';

export interface ApiServices {
  config: AppConfig;
  store: Store;
  settings: SettingsService;
  market: AppMarket;
  engine: RuleEngine;
  worker: DeliveryWorker;
  discord: DiscordClient;
  pushplus: PushplusClient;
  bus: EventEmitter;
}

class HttpError extends Error {
  statusCode: number;
  details?: unknown;
  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

function bodyObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '请求体必须是 JSON 对象');
  return body as Record<string, unknown>;
}

function intQuery(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function stringQuery(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/[^\s]*discord[^\s]*/gi, 'https://discord.com/api/webhooks/***')
    .slice(0, 1000);
}

function sendError(reply: FastifyReply, error: unknown, fallbackStatus = 500): void {
  const status = error instanceof HttpError ? error.statusCode : fallbackStatus;
  reply.code(status).send({
    error:
      error instanceof HttpError
        ? error.message
        : status >= 500
          ? '服务器内部错误'
          : safeError(error),
    ...(error instanceof HttpError && error.details ? { details: error.details } : {}),
  });
}

function eventFilters(query: unknown) {
  const q = (query ?? {}) as Record<string, unknown>;
  return {
    limit: Math.min(200, Math.max(1, intQuery(q.limit, 50))),
    offset: Math.max(0, intQuery(q.offset, 0)),
    status: stringQuery(q.status),
    ruleId: stringQuery(q.ruleId),
    symbol: stringQuery(q.symbol)?.toUpperCase(),
    from: q.from === undefined ? undefined : intQuery(q.from, 0),
    to: q.to === undefined ? undefined : intQuery(q.to, 0),
  };
}

function pseudoRule(draft: RuleDraft): Rule {
  const now = Date.now();
  return {
    ...draft,
    id: 'preview',
    enabled: true,
    version: 0,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
}

function buildStatus(services: ApiServices) {
  const publicSettings = services.settings.getPublic();
  return {
    ok: true,
    now: Date.now(),
    exchangeNow: services.market.exchangeNow(),
    wsConnected: services.market.isWsConnected(),
    wsState: services.market.getConnectionState(),
    discordConfigured: publicSettings.discordConfigured,
    notificationChannel: publicSettings.notificationChannel,
    notificationsConfigured: publicSettings.notificationsConfigured,
    proxyEnabled: Boolean(publicSettings.proxyUrl),
    version: services.config.version,
    startedAt: services.market.getStartedAt(),
  };
}

function replayChartTimeframe(raw: unknown): Timeframe | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !TIMEFRAMES.includes(raw as Timeframe)) return null;
  return raw as Timeframe;
}

function replayWindowDays(raw: Record<string, unknown>): number {
  const value = Number(raw.windowDays ?? 7);
  if (!Number.isFinite(value) || value < 1 || value > 30) {
    throw new HttpError(400, '回放窗口必须在 1–30 天之间');
  }
  return Math.round(value);
}

function replayPeriodInput(raw: Record<string, unknown>, now: number) {
  if (raw.period === undefined) return undefined;
  return normalizeReplayPeriod(raw.period, now);
}

function canonicalPositionConfig(config: PositionCalculatorConfig) {
  const exit = (rule: PositionCalculatorConfig['target']) => ({
    mode: rule.mode,
    ...(rule.mode === 'price' ? { price: rule.price } : {}),
    ...(rule.mode === 'percent' ? { percent: rule.percent } : {}),
    ...(rule.mode === 'roi' ? { roiPercent: rule.roiPercent } : {}),
    ...(rule.mode === 'indicator' ? { series: rule.series } : {}),
  });
  return {
    direction: config.direction,
    capital: config.capital,
    leverage: config.leverage,
    feeRatePct: config.feeRatePct,
    slippagePct: config.slippagePct,
    target: exit(config.target),
    stop: exit(config.stop),
  };
}

function positionCacheKey(config: PositionCalculatorConfig, triggerIndexes: number[]): string {
  return createHash('sha256').update(JSON.stringify({
    algorithm: 'position-calc-v6',
    config: canonicalPositionConfig(config),
    triggerIndexes: [...triggerIndexes].sort((a, b) => a - b),
  })).digest('hex');
}

export async function registerApiRoutes(app: FastifyInstance, services: ApiServices): Promise<void> {
  const { store, settings, market, engine, worker, discord, pushplus, bus, config } = services;
  const sseClients = new Set<() => void>();
  app.addHook('onClose', async () => {
    for (const cleanup of sseClients) cleanup();
    sseClients.clear();
  });

  app.get('/api/health', async () => ({
    status: 'ok',
    version: config.version,
    startedAt: market.getStartedAt(),
    now: Date.now(),
    exchangeNow: market.exchangeNow(),
    wsState: market.getConnectionState(),
    wsConnected: market.isWsConnected(),
    discordConfigured: settings.getPublic().discordConfigured,
    notificationChannel: settings.getPublic().notificationChannel,
    notificationsConfigured: settings.getPublic().notificationsConfigured,
  }));

  app.get('/api/status', async () => buildStatus(services));

  app.get('/api/dashboard', async () => {
    const now = market.exchangeNow();
    const dayStart = exchangeDayStartUtc8(now);
    const rules = store.listRules().map((rule) => toRuleView(rule, store, engine, now));
    const deliveries = store.countDeliveriesSince(dayStart);
    const lastMessageAt = market.getLastMessageAt();
    return {
      status: buildStatus(services),
      settings: settings.getPublic(),
      stats: {
        activeRules: rules.filter((rule) => rule.enabled).length,
        totalRules: rules.length,
        todayEvents: store.countEventsSince(dayStart),
        deliverySuccess: deliveries.sent,
        deliveryTotal: deliveries.total,
        marketLatencyMs: lastMessageAt ? Math.max(0, Date.now() - lastMessageAt) : null,
      },
      rules,
      recentEvents: store.listEvents({ limit: 8 }).events,
      marketPairs: market.listPairStatuses(),
    };
  });

  app.get('/api/rules', async () => {
    const now = market.exchangeNow();
    return { rules: store.listRules().map((rule) => toRuleView(rule, store, engine, now)) };
  });

  app.get('/api/rules/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const rule = store.getRule(id);
    if (!rule || rule.archivedAt) return sendError(reply, new HttpError(404, '规则不存在'), 404);
    return { rule: toRuleView(rule, store, engine, market.exchangeNow()) };
  });

  app.post('/api/rules', async (request, reply) => {
    const raw = bodyObject(request.body);
    const parsed = parseRuleInput(raw);
    if (!parsed.ok) return reply.code(400).send({ error: '规则校验失败', details: parsed.errors });
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
      return reply.code(400).send({ error: 'enabled 必须是布尔值' });
    }
    if (store.listRules().length >= 100) return reply.code(409).send({ error: '最多创建 100 条规则' });
    const rule = store.insertRule(parsed.value.draft, raw.enabled === true);
    engine.reloadRules();
    return reply.code(201).send({
      rule: toRuleView(rule, store, engine, market.exchangeNow()),
      warnings: parsed.value.warnings,
    });
  });

  app.put('/api/rules/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = store.getRule(id);
    if (!existing || existing.archivedAt) return sendError(reply, new HttpError(404, '规则不存在'), 404);
    const raw = bodyObject(request.body);
    const parsed = parseRuleInput(raw);
    if (!parsed.ok) return reply.code(400).send({ error: '规则校验失败', details: parsed.errors });
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
      return reply.code(400).send({ error: 'enabled 必须是布尔值' });
    }
    const updated = store.updateRule(
      id,
      parsed.value.draft,
      raw.enabled === undefined ? existing.enabled : raw.enabled,
    );
    if (!updated) return sendError(reply, new HttpError(404, '规则不存在'), 404);
    engine.reloadRules();
    return {
      rule: toRuleView(updated, store, engine, market.exchangeNow()),
      warnings: parsed.value.warnings,
    };
  });

  app.patch('/api/rules/:id/enabled', async (request, reply) => {
    const { id } = request.params as { id: string };
    const raw = bodyObject(request.body);
    if (typeof raw.enabled !== 'boolean') return reply.code(400).send({ error: 'enabled 必须是布尔值' });
    const updated = store.setRuleEnabled(id, raw.enabled);
    if (!updated) return sendError(reply, new HttpError(404, '规则不存在'), 404);
    engine.reloadRules();
    return { rule: toRuleView(updated, store, engine, market.exchangeNow()) };
  });

  app.delete('/api/rules/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.archiveRule(id)) return sendError(reply, new HttpError(404, '规则不存在'), 404);
    engine.reloadRules();
    return { ok: true };
  });

  app.post('/api/rules/:id/duplicate', async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = store.getRule(id);
    if (!existing || existing.archivedAt) return sendError(reply, new HttpError(404, '规则不存在'), 404);
    const draft: RuleDraft = {
      name: `${existing.name} 副本`.slice(0, 40),
      symbols: [...existing.symbols],
      triggerMode: existing.triggerMode,
      cooldownSec: existing.cooldownSec,
      expression: existing.expression,
      note: existing.note,
      skipUsNonTradingDays: existing.skipUsNonTradingDays === true,
    };
    const rule = store.insertRule(draft, false);
    engine.reloadRules();
    return reply.code(201).send({ rule: toRuleView(rule, store, engine, market.exchangeNow()) });
  });

  app.post('/api/rules/:id/trial', async (request, reply) => {
    const { id } = request.params as { id: string };
    const rule = store.getRule(id);
    if (!rule || rule.archivedAt) return sendError(reply, new HttpError(404, '规则不存在'), 404);
    const raw = bodyObject(request.body ?? {});
    const symbol = typeof raw.symbol === 'string' ? raw.symbol.trim().toUpperCase() : '';
    if (!symbol || !rule.symbols.includes(symbol)) {
      return reply.code(400).send({ error: '请选择规则内的一个回放品种' });
    }
    const windowDays = Number(raw.windowDays ?? 7);
    if (!Number.isFinite(windowDays) || windowDays < 1 || windowDays > 30) {
      return reply.code(400).send({ error: '回放窗口必须在 1–30 天之间' });
    }
    const chartTimeframe = replayChartTimeframe(raw.chartTimeframe);
    if (raw.chartTimeframe !== undefined && !chartTimeframe) {
      return reply.code(400).send({ error: '图表周期不合法' });
    }
    try {
      return await runTrial({
        draft: rule,
        symbol,
        windowDays: Math.round(windowDays),
        chartTimeframe: chartTimeframe ?? undefined,
        market,
        store,
        allowExtendedWindow: true,
      });
    } catch (error) {
      if (error instanceof HistoryError) return reply.code(error.statusCode).send({ error: error.message });
      if (error instanceof TrialError) return reply.code(error.statusCode).send({ error: error.message });
      return sendError(reply, new HttpError(502, `回放失败：${safeError(error)}`), 502);
    }
  });

  app.post('/api/rules/:id/replays', async (request, reply) => {
    const { id } = request.params as { id: string };
    const rule = store.getRule(id);
    if (!rule || rule.archivedAt) return sendError(reply, new HttpError(404, '规则不存在'), 404);
    const raw = bodyObject(request.body ?? {});
    const symbol = typeof raw.symbol === 'string' ? raw.symbol.trim().toUpperCase() : '';
    if (!symbol || !rule.symbols.includes(symbol)) {
      return reply.code(400).send({ error: '请选择规则内的一个回放品种' });
    }
    const chartTimeframe = replayChartTimeframe(raw.chartTimeframe);
    if (raw.chartTimeframe !== undefined && !chartTimeframe) {
      return reply.code(400).send({ error: '图表周期不合法' });
    }
    try {
      const period = replayPeriodInput(raw, market.exchangeNow());
      const windowDays = period ? 7 : replayWindowDays(raw);
      const params: ReplayExecutionParams = {
        symbol,
        windowDays,
        chartTimeframe: chartTimeframe ?? '5m',
        period,
      };
      const estimate = estimateReplayBars(rule, params, market.exchangeNow());
      if (estimate.maxBars > MAX_REPLAY_BARS_PER_TIMEFRAME) {
        return reply.code(422).send({ error: `所选时段需要 ${estimate.maxBars} 根 K 线，超过单周期上限 ${MAX_REPLAY_BARS_PER_TIMEFRAME}；请缩短范围或使用更大周期` });
      }
      const result = await runTrial({
        draft: rule,
        symbol,
        windowDays,
        chartTimeframe: chartTimeframe ?? undefined,
        market,
        store,
        period,
        allowExtendedWindow: true,
      });
      const replay = store.saveReplay({
        id: randomUUID(),
        ruleId: rule.id,
        ruleName: rule.name,
        ruleVersion: rule.version,
        symbol,
        windowDays: result.windowDays,
        chartTimeframe: result.timeframe,
        signalTimeframe: result.signalTimeframe,
        result,
        period: result.period,
        createdAt: Date.now(),
      });
      return reply.code(201).send({ replay });
    } catch (error) {
      if (error instanceof ReplayPeriodError) return reply.code(400).send({ error: error.message });
      if (error instanceof HistoryError) return reply.code(error.statusCode).send({ error: error.message });
      if (error instanceof TrialError) return reply.code(error.statusCode).send({ error: error.message });
      return sendError(reply, new HttpError(502, `回放失败：${safeError(error)}`), 502);
    }
  });

  app.post('/api/rules/:id/replays/async', async (request, reply) => {
    const { id } = request.params as { id: string };
    const rule = store.getRule(id);
    if (!rule || rule.archivedAt) return sendError(reply, new HttpError(404, '规则不存在'), 404);
    const raw = bodyObject(request.body ?? {});
    const symbol = typeof raw.symbol === 'string' ? raw.symbol.trim().toUpperCase() : '';
    if (!symbol || !rule.symbols.includes(symbol)) {
      return reply.code(400).send({ error: '请选择规则内的一个回放品种' });
    }
    const chartTimeframe = replayChartTimeframe(raw.chartTimeframe);
    if (raw.chartTimeframe !== undefined && !chartTimeframe) {
      return reply.code(400).send({ error: '图表周期不合法' });
    }
    try {
      const period = replayPeriodInput(raw, market.exchangeNow());
      const windowDays = period ? 7 : replayWindowDays(raw);
      const params: ReplayExecutionParams = {
        symbol,
        windowDays,
        chartTimeframe: chartTimeframe ?? '5m',
        period,
      };
      const estimate = estimateReplayBars(rule, params, market.exchangeNow());
      if (estimate.maxBars > MAX_REPLAY_BARS_PER_TIMEFRAME) {
        return reply.code(422).send({ error: `所选时段需要 ${estimate.maxBars} 根 K 线，超过单周期上限 ${MAX_REPLAY_BARS_PER_TIMEFRAME}；请缩短范围或使用更大周期` });
      }
      const estimatedSeconds = estimateReplaySeconds(rule, params, market.exchangeNow());
      const job = startReplayJob({ store, market, rule, params, estimatedSeconds });
      return reply.code(202).send({ job });
    } catch (error) {
      if (error instanceof ReplayPeriodError) return reply.code(400).send({ error: error.message });
      return sendError(reply, new HttpError(400, `创建回放任务失败：${safeError(error)}`), 400);
    }
  });

  app.get('/api/rules/:id/replays', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getRule(id)) return sendError(reply, new HttpError(404, '规则不存在'), 404);
    const q = (request.query ?? {}) as Record<string, unknown>;
    return { replays: store.listReplays(id, intQuery(q.limit, 20)) };
  });

  app.get('/api/replays/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const replay = store.getReplay(id);
    if (!replay) return sendError(reply, new HttpError(404, '回放记录不存在'), 404);
    return { replay };
  });

  app.get('/api/rules/:id/replay-jobs/active', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getRule(id)) return sendError(reply, new HttpError(404, '规则不存在'), 404);
    return { job: store.getActiveReplayJob(id) };
  });

  app.get('/api/replay-jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = store.getReplayJob(id);
    if (!job) return sendError(reply, new HttpError(404, '回放任务不存在'), 404);
    return { job };
  });

  app.get('/api/replays/:id/position-calculations', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getReplay(id)) return sendError(reply, new HttpError(404, '回放记录不存在'), 404);
    const q = (request.query ?? {}) as Record<string, unknown>;
    return { calculations: store.listPositionCalculations(id, intQuery(q.limit, 20)) };
  });

  app.get('/api/position-calculations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const calculation = store.getPositionCalculation(id);
    if (!calculation) return sendError(reply, new HttpError(404, '仓位计算记录不存在'), 404);
    return { calculation };
  });

  app.post('/api/replays/:id/position-calc', async (request, reply) => {
    const { id } = request.params as { id: string };
    const replay = store.getReplay(id);
    if (!replay) return sendError(reply, new HttpError(404, '回放记录不存在'), 404);
    const raw = bodyObject(request.body ?? {});
    try {
      const config = raw.config as Parameters<typeof validatePositionConfig>[0];
      if (!config || typeof config !== 'object') throw new PositionCalcError('缺少仓位计算参数');
      validatePositionConfig(config);
      const indexesRaw = raw.triggerIndexes;
      const triggerIndexes = [...new Set(indexesRaw === undefined
        ? replay.result.triggers.map((_, index) => index)
        : Array.isArray(indexesRaw) ? indexesRaw.map(Number) : [])].sort((a, b) => a - b);
      if (!triggerIndexes.length) throw new PositionCalcError('请至少选择一个信号点');
      for (const index of triggerIndexes) {
        if (!Number.isInteger(index) || index < 0 || index >= replay.result.triggers.length) {
          throw new PositionCalcError(`信号序号不合法：${index}`);
        }
      }
      const signalTimeframe = replay.result.signalTimeframe;
      const tfMs = TF_MS[signalTimeframe];
      const endTime = replay.period?.to ?? (replay.result.data.to + tfMs);
      const cacheKey = positionCacheKey(config, triggerIndexes);
      const cached = store.findPositionCalculation(id, cacheKey);
      if (cached) {
        return {
          calculation: cached.calculation,
          calculationId: cached.id,
          cached: true,
        };
      }
      const firstTrigger = Math.min(...triggerIndexes.map((index) => replay.result.triggers[index]?.barOpenTime ?? Infinity));
      if (!Number.isFinite(firstTrigger)) throw new PositionCalcError('信号序号不合法');
      const loadFrom = Math.floor((firstTrigger - MIN_HISTORY_BARS * tfMs) / tfMs) * tfMs;
      const loaded = await loadLocalFirstHistory({
        store,
        market,
        instId: replay.symbol,
        timeframe: signalTimeframe,
        from: loadFrom,
        to: endTime,
        strictRange: true,
        maxPages: Math.max(140, Math.ceil((endTime - loadFrom) / tfMs / 100) + 16),
      });
      const candles = loaded.candles.filter((candle) => candle.confirm);
      if (!candles.length) throw new HistoryError('没有可用于仓位计算的信号周期 K 线', 422);

      // Indicator exits are computed from the signal-timeframe candles, not
      // from an arbitrary different chart timeframe. Enrich trigger snapshots
      // with a synthetic price series value when a configured exit asks for it.
      const enrichedTriggers = replay.result.triggers.map((trigger) => ({
        ...trigger,
        conditions: [...trigger.conditions],
      }));
      const indicatorSeries = [...new Set([
        config.target.mode === 'indicator' ? config.target.series : null,
        config.stop.mode === 'indicator' ? config.stop.series : null,
      ].filter((series): series is NonNullable<typeof series> => Boolean(series)))];
      for (const series of indicatorSeries) {
        const params = normalizeParams(series, undefined);
        const values = computeSeries(candles, series, params);
        for (let index = 0; index < enrichedTriggers.length; index++) {
          const trigger = enrichedTriggers[index];
          const candleIndex = candles.findIndex((candle) => candle.openTime === trigger.barOpenTime);
          if (candleIndex < 0) continue;
          const value = values[candleIndex];
          if (value === null || value === undefined || !Number.isFinite(value)) continue;
          const snapshot: ConditionEvaluation = {
            conditionId: `position-${series}-${index}`,
            timeframe: signalTimeframe,
            leftSeries: series,
            rightSeries: null,
            leftValue: value,
            rightValue: null,
            cmp: 'gte',
            truth: true,
            barOpenTime: trigger.barOpenTime,
            barCloseTime: trigger.barCloseTime,
            leftParams: params,
            rightParams: null,
          };
          trigger.conditions.push(snapshot);
        }
      }
      const calculation = calculatePositions({
        triggers: enrichedTriggers,
        triggerIndexes,
        candles,
        timeframeMs: tfMs,
        endTime,
        config,
        symbol: replay.symbol,
      });
      const saved = store.savePositionCalculation({
        id: randomUUID(),
        replayId: replay.id,
        cacheKey,
        config,
        triggerIndexes,
        calculation,
        createdAt: Date.now(),
      });
      return { calculation, calculationId: saved.id, cached: false };
    } catch (error) {
      if (error instanceof PositionCalcError) return reply.code(400).send({ error: error.message });
      if (error instanceof HistoryError) return reply.code(error.statusCode).send({ error: `仓位计算前补全信号周期数据失败：${error.message}` });
      return sendError(reply, new HttpError(502, `仓位计算失败：${safeError(error)}`), 502);
    }
  });

  app.get('/api/replays/:id/chart-candles', async (request, reply) => {
    const { id } = request.params as { id: string };
    const replay = store.getReplay(id);
    if (!replay) return sendError(reply, new HttpError(404, '回放记录不存在'), 404);
    const q = (request.query ?? {}) as Record<string, unknown>;
    const timeframe = typeof q.timeframe === 'string' ? q.timeframe : '';
    if (!TIMEFRAMES.includes(timeframe as Timeframe)) {
      return reply.code(400).send({ error: 'K 线周期不合法' });
    }
    const to = replay.period?.to ?? (replay.result.data.to + TF_MS[replay.result.timeframe]);
    const from = replay.period?.from ?? (replay.result.data.to - replay.windowDays * 86_400_000);
    try {
      const history = await loadLocalFirstHistory({
        store,
        market,
        instId: replay.symbol,
        timeframe: timeframe as Timeframe,
        from,
        to,
      });
      return {
        replayId: replay.id,
        symbol: replay.symbol,
        timeframe,
        candles: history.candles,
        data: {
          source: history.source,
          localBars: history.localBars,
          fetchedBars: history.fetchedBars,
          coverage: history.coverage,
          gaps: history.gaps,
        },
      };
    } catch (error) {
      if (error instanceof HistoryError) return reply.code(error.statusCode).send({ error: error.message });
      return sendError(reply, new HttpError(502, `加载图表周期失败：${safeError(error)}`), 502);
    }
  });

  app.post('/api/rules/validate', async (request, reply) => {
    const parsed = parseRuleInput(bodyObject(request.body));
    if (!parsed.ok) return reply.code(400).send({ error: '规则校验失败', details: parsed.errors });
    return { ok: true, summary: ruleSummary(parsed.value.draft.expression), warnings: parsed.value.warnings };
  });

  app.post('/api/rules/preview', async (request, reply) => {
    const parsed = parseRuleInput(bodyObject(request.body));
    if (!parsed.ok) return reply.code(400).send({ error: '规则校验失败', details: parsed.errors });
    const rule = pseudoRule(parsed.value.draft);
    return {
      summary: ruleSummary(rule.expression),
      warnings: parsed.value.warnings,
      results: engine.previewRule(rule),
    };
  });

  app.post('/api/rules/trial', async (request, reply) => {
    const raw = bodyObject(request.body);
    const parsed = parseRuleInput(raw);
    if (!parsed.ok) return reply.code(400).send({ error: '规则校验失败', details: parsed.errors });
    const symbol = typeof raw.symbol === 'string' ? raw.symbol.trim().toUpperCase() : '';
    if (!symbol || !parsed.value.draft.symbols.includes(symbol)) {
      return reply.code(400).send({ error: '请选择规则内的一个试跑品种' });
    }
    const windowDays = Number(raw.windowDays ?? 7);
    if (!Number.isFinite(windowDays) || windowDays < 1 || windowDays > 30) {
      return reply.code(400).send({ error: '试跑窗口必须在 1–30 天之间' });
    }
    const chartTimeframe = replayChartTimeframe(raw.chartTimeframe);
    if (raw.chartTimeframe !== undefined && !chartTimeframe) {
      return reply.code(400).send({ error: '图表周期不合法' });
    }
    try {
      return await runTrial({
        draft: parsed.value.draft,
        symbol,
        windowDays: Math.round(windowDays),
        chartTimeframe: chartTimeframe ?? undefined,
        market,
        store,
        allowExtendedWindow: true,
      });
    } catch (error) {
      if (error instanceof HistoryError) return reply.code(error.statusCode).send({ error: error.message });
      if (error instanceof TrialError) return reply.code(error.statusCode).send({ error: error.message });
      return sendError(reply, new HttpError(502, `试跑失败：${safeError(error)}`), 502);
    }
  });

  app.get('/api/events', async (request) => {
    const result = store.listEvents(eventFilters(request.query));
    return result;
  });

  app.get('/api/events/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const event = store.getEvent(id);
    if (!event) return sendError(reply, new HttpError(404, '事件不存在'), 404);
    return { event };
  });

  app.post('/api/events/:id/retry', async (request, reply) => {
    const { id } = request.params as { id: string };
    const event = store.getEvent(id);
    if (!event) return sendError(reply, new HttpError(404, '事件不存在'), 404);
    const channel = event.delivery?.channel ?? 'discord';
    if (!settings.isNotificationConfigured(channel)) {
      return reply.code(409).send({
        error: channel === 'pushplus'
          ? '请先在设置中配置 PushPlus Token'
          : '请先在设置中配置 Discord Webhook',
      });
    }
    if (!event.delivery || !['dead', 'skipped', 'pending'].includes(event.delivery.status)) {
      return reply.code(409).send({ error: '该事件当前不能重试' });
    }
    if (!store.retryDelivery(id)) return reply.code(409).send({ error: '该事件当前不能重试' });
    worker.wake();
    return { event: store.getEvent(id) };
  });

  app.get('/api/candles', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, unknown>;
    const instId = stringQuery(q.instId);
    const timeframe = stringQuery(q.timeframe) as Timeframe | undefined;
    if (!instId || !timeframe || !TIMEFRAMES.includes(timeframe)) {
      return reply.code(400).send({ error: 'instId 或 timeframe 不合法' });
    }
    const limit = Math.min(1_000, Math.max(20, intQuery(q.limit, 200)));
    const before = q.before === undefined ? null : intQuery(q.before, 0);
    if (before !== null && before <= 0) {
      return reply.code(400).send({ error: 'before 必须是毫秒时间戳' });
    }

    const merge = (lists: Candle[][]): Candle[] => {
      const map = new Map<number, Candle>();
      for (const list of lists) {
        for (const candle of list) {
          const previous = map.get(candle.openTime);
          // Prefer a confirmed bar over an in-progress snapshot at the same timestamp.
          if (!previous || candle.confirm || !previous.confirm) map.set(candle.openTime, candle);
        }
      }
      return [...map.values()].sort((a, b) => a.openTime - b.openTime);
    };

    let candles: Candle[];
    let hasMore = false;
    if (before !== null) {
      candles = store.getCandlesBefore(instId, timeframe, before, limit);
      if (!candles.length) {
        try {
          const from = before - limit * TF_MS[timeframe];
          const fetched = (await market.fetchHistory(instId, timeframe, from, before)).filter((candle) => candle.confirm);
          if (fetched.length) store.upsertCandles(fetched);
          candles = store.getCandlesBefore(instId, timeframe, before, limit);
        } catch (error) {
          return reply.code(502).send({ error: `加载 K 线失败：${safeError(error)}` });
        }
      }
      const oldest = candles[0]?.openTime;
      hasMore = oldest !== undefined && store.hasCandlesBefore(instId, timeframe, oldest);
    } else {
      const live = market.getCandlesIncludingForming(instId, timeframe, limit);
      const closed = store.getCandles(instId, timeframe, limit, true);
      candles = merge([closed, live]).slice(-limit);
      if (!candles.length) {
        try {
          const now = market.exchangeNow();
          const fetched = (await market.fetchHistory(instId, timeframe, now - limit * TF_MS[timeframe], now)).filter(
            (candle) => candle.confirm,
          );
          if (fetched.length) store.upsertCandles(fetched);
          candles = merge([store.getCandles(instId, timeframe, limit, true), live]).slice(-limit);
        } catch (error) {
          return reply.code(502).send({ error: `加载 K 线失败：${safeError(error)}` });
        }
      }
      const oldest = candles[0]?.openTime;
      hasMore = oldest !== undefined && store.hasCandlesBefore(instId, timeframe, oldest);
    }

    return {
      instId,
      timeframe,
      candles,
      page: {
        hasMore,
        oldest: candles[0]?.openTime ?? null,
        newest: candles[candles.length - 1]?.openTime ?? null,
      },
    };
  });

  app.get('/api/candles/stream', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, unknown>;
    const instId = stringQuery(q.instId)?.toUpperCase();
    const timeframe = stringQuery(q.timeframe) as Timeframe | undefined;
    if (!instId || !timeframe || !TIMEFRAMES.includes(timeframe)) {
      return reply.code(400).send({ error: 'instId 或 timeframe 不合法' });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');

    let closed = false;
    let pending: Candle | null = null;
    let flushTimer: NodeJS.Timeout | null = null;
    let heartbeat: NodeJS.Timeout | null = null;
    let lastKey = '';

    const write = (event: string, payload: unknown): void => {
      if (closed || reply.raw.destroyed || reply.raw.writableEnded) return;
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    const flush = (): void => {
      flushTimer = null;
      if (!pending || closed) return;
      const candle = pending;
      pending = null;
      const key = `${candle.openTime}|${candle.confirm ? 1 : 0}|${candle.close}|${candle.volume}`;
      if (key === lastKey) return;
      lastKey = key;
      write('candle', { candle });
    };

    const onCandle = (candle: Candle): void => {
      if (closed || candle.instId !== instId || candle.timeframe !== timeframe) return;
      pending = candle;
      if (!flushTimer) flushTimer = setTimeout(flush, 250);
    };

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (flushTimer) clearTimeout(flushTimer);
      if (heartbeat) clearInterval(heartbeat);
      market.off('tick', onCandle);
      market.off('closed', onCandle);
      void market.releaseChartPair?.({ instId, timeframe });
    };

    market.on('tick', onCandle);
    market.on('closed', onCandle);
    request.raw.on('close', cleanup);
    reply.raw.on('close', cleanup);

    try {
      await market.addChartPair?.({ instId, timeframe });
      const snapshot = market.getCandlesIncludingForming(instId, timeframe, 1)[0];
      if (snapshot) {
        pending = snapshot;
        flush();
      }
    } catch (error) {
      write('error', { error: `订阅 K 线失败：${safeError(error)}` });
      cleanup();
      reply.raw.end();
      return;
    }

    heartbeat = setInterval(() => write('heartbeat', { now: Date.now() }), 15_000);
    heartbeat.unref?.();
  });

  app.get('/api/instruments', async (request, reply) => {
    const query = stringQuery((request.query as Record<string, unknown>)?.query) ?? '';
    try {
      return { instruments: await market.getInstruments(query) };
    } catch (error) {
      return reply.code(502).send({ error: `获取 OKX 品种失败：${safeError(error)}` });
    }
  });

  app.get('/api/settings', async () => ({ settings: settings.getPublic() }));

  app.put('/api/settings', async (request, reply) => {
    const parsed = settings.validateUpdate(request.body);
    if (!parsed.ok) return reply.code(400).send({ error: '设置校验失败', details: parsed.errors });
    const result = settings.update(parsed.value);
    if (result.proxyChanged && market.restartForProxyChange) {
      void market.restartForProxyChange().catch((error: unknown) => {
        request.log.warn({ err: error }, 'failed to restart market after proxy change');
      });
    }
    if (result.webhookChanged || result.notificationChanged) worker.wake();
    return { settings: result.publicSettings };
  });

  app.post('/api/settings/test-okx', async (request, reply) => {
    const raw = bodyObject(request.body ?? {});
    let proxy: string | undefined;
    if (raw.proxyUrl !== undefined) {
      if (typeof raw.proxyUrl !== 'string') return reply.code(400).send({ error: '代理地址必须是字符串' });
      const invalid = validateProxyUrl(raw.proxyUrl);
      if (invalid) return reply.code(400).send({ error: invalid });
      proxy = raw.proxyUrl.trim();
    }
    try {
      const result = await market.testConnection(proxy);
      return { ok: true, latencyMs: result.latencyMs, serverNow: result.serverNow };
    } catch (error) {
      return reply.code(502).send({ ok: false, error: safeError(error) });
    }
  });

  app.post('/api/settings/test-pushplus', async (request, reply) => {
    const raw = bodyObject(request.body ?? {});
    let token: string;
    if (typeof raw.pushplusToken === 'string' && raw.pushplusToken.trim()) {
      const normalized = raw.pushplusToken.trim();
      const invalid = validatePushplusToken(normalized);
      if (invalid) return reply.code(400).send({ error: invalid });
      token = normalized;
    } else {
      token = settings.getPushplusToken();
    }
    if (!token) return reply.code(400).send({ error: '请先填写 PushPlus Token' });
    const topic = typeof raw.pushplusTopic === 'string' ? raw.pushplusTopic.trim() : settings.getPushplusTopic();
    if (topic.length > 64 || /[\r\n]/.test(topic)) {
      return reply.code(400).send({ error: 'PushPlus 群组编码不能超过 64 个字符且不能包含换行' });
    }
    const result = await pushplus.sendTest(token, topic);
    if (!result.ok) return reply.code(502).send({ error: result.error });
    return { ok: true, httpStatus: result.httpStatus, messageId: result.messageId };
  });

  app.post('/api/settings/test-discord', async (request, reply) => {
    const raw = bodyObject(request.body ?? {});
    let webhookUrl: string;
    if (typeof raw.webhookUrl === 'string' && raw.webhookUrl.trim()) {
      const invalid = validateDiscordWebhook(raw.webhookUrl.trim());
      if (invalid) return reply.code(400).send({ error: invalid });
      webhookUrl = raw.webhookUrl.trim();
    } else {
      webhookUrl = settings.getPrivate().discordWebhookUrl;
    }
    if (!webhookUrl) return reply.code(400).send({ error: '请先填写 Discord Webhook URL' });
    const result = await discord.sendTest(webhookUrl);
    if (!result.ok) return reply.code(502).send({ error: result.error });
    return { ok: true, httpStatus: result.httpStatus, messageId: result.messageId };
  });

  app.get('/api/diagnostics', async () => ({
    app: buildStatus(services),
    marketPairs: market.listPairStatuses(),
    deliveryQueue: store.deliveryQueueCounts(),
    dataCounts: {
      events: store.countEventsSince(0),
      candles: store.countCandles(),
      databaseBytes: store.databaseBytes(),
    },
    recentErrors: market.getRecentErrors(),
  }));

  app.get('/api/stream', (request, reply) => {
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    response.write('retry: 2000\n\n');
    const send = (payload: unknown) => {
      response.write(`event: refresh\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    send({ type: 'connected', at: Date.now() });
    const onRefresh = (payload: unknown) => send(payload);
    bus.on('refresh', onRefresh);
    const heartbeat = setInterval(() => {
      try {
        response.write(`: heartbeat ${Date.now()}\n\n`);
      } catch {
        // closed
      }
    }, 20_000);
    heartbeat.unref?.();
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      bus.off('refresh', onRefresh);
      sseClients.delete(cleanup);
      if (!response.writableEnded) response.end();
    };
    sseClients.add(cleanup);
    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
  });
}
