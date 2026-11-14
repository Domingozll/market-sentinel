import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { AppConfig } from './config';
import { loadConfig } from './config';
import { Store } from './store';
import { SettingsService } from './settings';
import { NetworkContext } from './network';
import { OkxRestClient } from './market/okx-rest';
import { MarketService } from './market/service';
import type { AppMarket } from './market/provider';
import { RuleEngine } from './rules/engine';
import { DiscordClient, type DiscordTransport } from './alerts/discord';
import { PushplusClient, type PushplusTransport } from './alerts/pushplus';
import { DeliveryWorker } from './alerts/worker';
import { registerApiRoutes } from './api/routes';

export interface RuntimeOptions {
  config?: Partial<AppConfig>;
  market?: AppMarket;
  discordTransport?: DiscordTransport;
  pushplusTransport?: PushplusTransport;
  allowNonOfficialDiscord?: boolean;
  serveStatic?: boolean;
  logger?: FastifyServerOptions['logger'];
  dataDir?: string;
  engineTiming?: { settleMs?: number; tickThrottleMs?: number; baselineDelayMs?: number };
}

export interface Runtime {
  config: AppConfig;
  store: Store;
  settings: SettingsService;
  network: NetworkContext;
  rest: OkxRestClient;
  market: AppMarket;
  discord: DiscordClient;
  pushplus: PushplusClient;
  worker: DeliveryWorker;
  engine: RuleEngine;
  bus: EventEmitter;
  app: FastifyInstance;
  started: boolean;
  timers: NodeJS.Timeout[];
  stop: () => Promise<void>;
}

function publishRefreshes(bus: EventEmitter): { publish: () => void; timer: () => NodeJS.Timeout | null } {
  let pending = false;
  let timer: NodeJS.Timeout | null = null;
  const publish = () => {
    pending = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!pending) return;
      pending = false;
      bus.emit('refresh', { type: 'refresh', at: Date.now() });
    }, 300);
    timer.unref?.();
  };
  return { publish, timer: () => timer };
}

function exists(file: string): boolean {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

export async function createRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  const config = loadConfig({ ...options.config, ...(options.dataDir ? { dataDir: options.dataDir } : {}) });
  const store = new Store(config.dataDir);
  const settings = new SettingsService(store, config);
  settings.init();
  const network = new NetworkContext();
  network.updateProxy(settings.getProxyForMarket());
  const rest = new OkxRestClient({
    baseUrl: config.okxRestBase,
    network,
    getProxy: () => settings.getProxyForMarket(),
  });
  const market = options.market
    ? options.market
    : new MarketService({
        config,
        store,
        rest,
        network,
        getProxy: () => settings.getProxyForMarket(),
      });
  const discord = new DiscordClient({
    network,
    getProxy: () => settings.getProxyForDiscord(),
    transport: options.discordTransport,
    allowNonOfficialUrls: options.allowNonOfficialDiscord ?? false,
  });
  const pushplus = new PushplusClient({
    network,
    getProxy: () => settings.getProxyForPushplus(),
    transport: options.pushplusTransport,
  });
  const worker = new DeliveryWorker({
    store,
    discord,
    getWebhookUrl: () => settings.getPrivate().discordWebhookUrl,
    pushplus,
    getPushplusToken: () => settings.getPushplusToken(),
    getPushplusTopic: () => settings.getPushplusTopic(),
  });
  const engine = new RuleEngine({
    store,
    market,
    isNotificationConfigured: () => settings.isNotificationConfigured(),
    getNotificationChannel: () => settings.getPrivate().notificationChannel,
    settleMs: options.engineTiming?.settleMs,
    tickThrottleMs: options.engineTiming?.tickThrottleMs,
    baselineDelayMs: options.engineTiming?.baselineDelayMs,
  });
  const bus = new EventEmitter();
  bus.setMaxListeners(100);
  const refresher = publishRefreshes(bus);
  engine.on('stateChanged', refresher.publish);
  engine.on('rulesChanged', refresher.publish);
  engine.on('triggered', refresher.publish);
  engine.on('diagnosticError', (message: string) => {
    if (process.env.NODE_ENV !== 'test') console.error('[engine]', message);
    refresher.publish();
  });
  market.on('status', refresher.publish);
  market.on('resync', refresher.publish);
  market.on('marketError', refresher.publish);
  worker.on('deliveryUpdated', refresher.publish);

  const serveStatic =
    options.serveStatic !== false && exists(path.join(config.webDist, 'index.html'));
  const app = await buildApp(config, {
    store,
    settings,
    market,
    engine,
    worker,
    discord,
    pushplus,
    bus,
    serveStatic,
    logger: options.logger,
  });

  const timers: NodeJS.Timeout[] = [];
  const runtime: Runtime = {
    config,
    store,
    settings,
    network,
    rest,
    market,
    discord,
    pushplus,
    worker,
    engine,
    bus,
    app,
    started: false,
    timers,
    stop: async () => {
      for (const timer of timers) clearInterval(timer);
      timers.length = 0;
      const refreshTimer = refresher.timer();
      if (refreshTimer) clearTimeout(refreshTimer);
      await worker.stop();
      await engine.stop();
      await market.stop();
      await app.close();
      store.close();
    },
  };
  return runtime;
}

async function buildApp(
  config: AppConfig,
  services: Pick<Runtime, 'store' | 'settings' | 'market' | 'engine' | 'worker' | 'discord' | 'pushplus' | 'bus'> & {
    serveStatic: boolean;
    logger?: FastifyServerOptions['logger'];
  },
): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      services.logger === undefined
        ? {
            level: config.logLevel,
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'webhookUrl',
                '*.webhookUrl',
                '*.discordWebhookUrl',
              ],
              censor: '[REDACTED]',
            },
          }
        : services.logger,
    bodyLimit: 1024 * 1024,
    trustProxy: false,
    requestTimeout: 30_000,
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (!reply.getHeader('Content-Security-Policy')) {
      reply.header(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:",
      );
    }
    return payload;
  });

  app.addHook('onRequest', async (request, reply) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin) {
        let allowed = false;
        try {
          const parsed = new URL(origin);
          allowed = parsed.host === request.headers.host;
        } catch {
          allowed = false;
        }
        if (!allowed) {
          return reply.code(403).send({ error: '拒绝跨站请求' });
        }
      }
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'request failed');
    }
    reply.code(statusCode).send({
      error: statusCode >= 500 ? '服务器内部错误' : error instanceof Error ? error.message : '请求失败',
    });
  });

  await registerApiRoutes(app, { config, ...services });

  if (services.serveStatic) {
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: '接口不存在' });
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return reply.code(404).send({ error: 'Not found' });
      }
      return serveWebFile(config.webDist, request.raw.url ?? request.url, reply);
    });
  } else {
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: '接口不存在' });
      return reply.code(404).send({ error: '前端资源尚未构建' });
    });
  }

  return app;
}

export async function startRuntime(runtime: Runtime): Promise<string> {
  if (runtime.started) return runtime.app.server.address() ? String(runtime.app.server.address()) : '';
  runtime.started = true;
  const address = await runtime.app.listen({ host: runtime.config.host, port: runtime.config.port });
  void runtime.market.start?.().catch((error) => {
    if (process.env.NODE_ENV !== 'test') console.error('[market] start failed', error);
  });
  runtime.worker.start();
  await runtime.engine.start();
  const runMaintenance = () => {
    try {
      const retention = runtime.settings.getPrivate().eventRetentionDays;
      runtime.store.pruneEvents(Date.now() - retention * 86_400_000);
      runtime.store.pruneCandles(Date.now());
    } catch (error) {
      if (process.env.NODE_ENV !== 'test') console.error('[maintenance]', error);
    }
  };
  runMaintenance();
  const maintenanceTimer = setInterval(runMaintenance, 3_600_000);
  maintenanceTimer.unref?.();
  runtime.timers.push(maintenanceTimer);
  return address;
}


const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Serve only regular files inside the built web root. No directory listing,
 * no dotfiles, no path traversal, and no SPA fallback for missing asset URLs.
 */
async function serveWebFile(
  webDist: string,
  rawUrl: string,
  reply: import('fastify').FastifyReply,
): Promise<unknown> {
  const root = path.resolve(webDist);
  const rawPath = rawUrl.split('?')[0].split('#')[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return reply.code(400).send({ error: '非法路径' });
  }
  if (decoded.includes('\0') || decoded.includes('\\')) {
    return reply.code(400).send({ error: '非法路径' });
  }
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some((segment) => segment.startsWith('.'))) {
    return reply.code(404).send({ error: 'Not found' });
  }
  let target = path.resolve(root, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  const rootPrefix = `${root}${path.sep}`;
  if (target !== root && !target.startsWith(rootPrefix)) {
    return reply.code(404).send({ error: 'Not found' });
  }
  try {
    let stat = fs.statSync(target);
    if (stat.isDirectory()) {
      target = path.join(target, 'index.html');
      stat = fs.statSync(target);
    }
    if (!stat.isFile()) return reply.code(404).send({ error: 'Not found' });
  } catch {
    // SPA routes (/rules, /events, ...) don't exist on disk; hashed asset URLs do not get an HTML fallback.
    if (path.extname(decoded)) return reply.code(404).send({ error: 'Not found' });
    target = path.join(root, 'index.html');
    if (!exists(target)) return reply.code(404).send({ error: '前端资源尚未构建' });
  }
  const ext = path.extname(target).toLowerCase();
  const cache = ext === '.html' ? 'no-store' : decoded.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
  reply.header('Cache-Control', cache);
  reply.type(MIME_TYPES[ext] ?? 'application/octet-stream');
  return reply.send(fs.createReadStream(target));
}
