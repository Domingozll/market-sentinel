import path from 'node:path';

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  webDist: string;
  okxRestBase: string;
  okxWsUrl: string;
  proxyUrl: string;
  discordWebhookUrl: string;
  pushplusToken: string;
  pushplusTopic: string;
  notificationChannel: string;
  logLevel: string;
  timezone: string;
  version: string;
  appBaseUrl: string;
  minHistoryBars: number;
  reconcileIntervalMs: number;
  deliveryPollMs: number;
}

function env(name: string, fallback = ''): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function parsePort(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Invalid PORT: ${raw}`);
  }
  return value;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const root = process.cwd();
  const dataDir = path.resolve(root, env('DATA_DIR', './data'));
  return {
    host: env('HOST', '127.0.0.1'),
    port: parsePort(env('PORT', '8787')),
    dataDir,
    webDist: path.resolve(root, env('WEB_DIST', path.join('dist', 'web'))),
    okxRestBase: env('OKX_REST_BASE', 'https://openapi.okx.com').replace(/\/$/, ''),
    okxWsUrl: env('OKX_WS_URL', 'wss://ws.okx.com/ws/v5/business'),
    proxyUrl: env('PROXY_URL'),
    discordWebhookUrl: env('DISCORD_WEBHOOK_URL'),
    pushplusToken: env('PUSHPLUS_TOKEN'),
    pushplusTopic: env('PUSHPLUS_TOPIC'),
    notificationChannel: env('NOTIFICATION_CHANNEL', 'discord'),
    logLevel: env('LOG_LEVEL', 'info'),
    timezone: env('TZ', 'Asia/Shanghai'),
    version: env('APP_VERSION', '1.0.0'),
    appBaseUrl: env('APP_BASE_URL', 'http://127.0.0.1:8787'),
    minHistoryBars: Number(env('MIN_HISTORY_BARS', '200')),
    reconcileIntervalMs: Number(env('RECONCILE_INTERVAL_MS', '60000')),
    deliveryPollMs: Number(env('DELIVERY_POLL_MS', '1000')),
    ...overrides,
  };
}

export function exchangeDayStartUtc8(now: number): number {
  const offset = 8 * 3_600_000;
  const local = now + offset;
  const day = Math.floor(local / 86_400_000) * 86_400_000;
  return day - offset;
}
