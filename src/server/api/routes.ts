import type { FastifyInstance, FastifyReply } from 'fastify';
import type { EventEmitter } from 'node:events';
import {
  type EventView,
  type Rule,
  type RuleDraft,
  TF_MS,
  TIMEFRAMES,
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
    };
    const rule = store.insertRule(draft, false);
    engine.reloadRules();
    return reply.code(201).send({ rule: toRuleView(rule, store, engine, market.exchangeNow()) });
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
    try {
      return await runTrial({
        draft: parsed.value.draft,
        symbol,
        windowDays: Math.round(windowDays),
        market,
      });
    } catch (error) {
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
    const limit = Math.min(500, Math.max(20, intQuery(q.limit, 200)));
    let candles = market.getCandlesIncludingForming(instId, timeframe, limit);
    if (!candles.length) {
      try {
        const now = market.exchangeNow();
        candles = await market.fetchHistory(instId, timeframe, now - limit * TF_MS[timeframe], now);
      } catch (error) {
        return reply.code(502).send({ error: `加载 K 线失败：${safeError(error)}` });
      }
    }
    return { instId, timeframe, candles };
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
