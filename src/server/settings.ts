import type { AppConfig } from './config';
import type { Store } from './store';
import { NOTIFICATION_CHANNELS, type NotificationChannel, type PublicSettings } from '../shared/types';
import { DEFAULT_COOLDOWN_SEC, DEFAULT_RETENTION_DAYS } from '../shared/types';
import { validateProxyUrl } from './network';

export interface PrivateSettings {
  discordWebhookUrl: string;
  notificationChannel: NotificationChannel;
  pushplusToken: string;
  pushplusTopic: string;
  proxyUrl: string;
  useProxyForDiscord: boolean;
  defaultCooldownSec: number;
  eventRetentionDays: number;
}

export interface SettingsUpdate {
  discordWebhookUrl?: string | null;
  notificationChannel?: NotificationChannel;
  pushplusToken?: string | null;
  pushplusTopic?: string;
  proxyUrl?: string;
  useProxyForDiscord?: boolean;
  defaultCooldownSec?: number;
  eventRetentionDays?: number;
}

export interface SettingsUpdateResult {
  settings: PrivateSettings;
  publicSettings: PublicSettings;
  proxyChanged: boolean;
  webhookChanged: boolean;
  notificationChanged: boolean;
}

const KEYS = {
  webhook: 'discord_webhook_url',
  channel: 'notification_channel',
  pushplusToken: 'pushplus_token',
  pushplusTopic: 'pushplus_topic',
  proxy: 'proxy_url',
  discordProxy: 'discord_use_proxy',
  cooldown: 'default_cooldown_sec',
  retention: 'event_retention_days',
} as const;

export function validateDiscordWebhook(url: string): string | null {
  if (!url.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return 'Webhook URL 不是合法 URL';
  }
  if (parsed.protocol !== 'https:') return 'Webhook URL 必须使用 https://';
  if (!['discord.com', 'discordapp.com'].includes(parsed.hostname)) {
    return '只允许 Discord 官方 Webhook 域名（discord.com / discordapp.com）';
  }
  if (!parsed.pathname.startsWith('/api/webhooks/')) return 'Webhook 路径必须为 /api/webhooks/…';
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 4 || !segments[2] || !segments[3]) return 'Webhook URL 不完整';
  return null;
}

export function validatePushplusToken(token: string): string | null {
  const value = token.trim();
  if (!value) return null;
  if (value.length < 8 || value.length > 128) return 'PushPlus Token 长度需为 8–128 个字符';
  if (/\s/.test(value) || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return 'PushPlus Token 只能包含字母、数字、下划线和连字符';
  }
  return null;
}

export function maskPushplusToken(token: string): string {
  if (!token) return '';
  return `••••••••${token.slice(-4)}`;
}

function normalizeChannel(raw: string | null | undefined, fallback: NotificationChannel = 'discord'): NotificationChannel {
  return raw === 'pushplus' || raw === 'discord' ? raw : fallback;
}

export function maskWebhook(url: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const id = segments[2] ?? '';
    const token = segments[3] ?? '';
    return `https://${parsed.hostname}/api/webhooks/${id.slice(0, 6)}…/…${token.slice(-4)}`;
  } catch {
    return '••••配置异常';
  }
}

export class SettingsService {
  private store: Store;
  private config: AppConfig;

  constructor(store: Store, config: AppConfig) {
    this.store = store;
    this.config = config;
  }

  init(): void {
    this.ensureDefault(KEYS.webhook, this.config.discordWebhookUrl);
    this.ensureDefault(KEYS.channel, normalizeChannel(this.config.notificationChannel));
    this.ensureDefault(KEYS.pushplusToken, this.config.pushplusToken);
    this.ensureDefault(KEYS.pushplusTopic, this.config.pushplusTopic);
    this.ensureDefault(KEYS.proxy, this.config.proxyUrl);
    this.ensureDefault(KEYS.discordProxy, this.config.proxyUrl ? '1' : '1');
    this.ensureDefault(KEYS.cooldown, String(DEFAULT_COOLDOWN_SEC));
    this.ensureDefault(KEYS.retention, String(DEFAULT_RETENTION_DAYS));
  }

  private ensureDefault(key: string, value: string): void {
    if (this.store.getSetting(key) === null) this.store.setSetting(key, value);
  }

  getPrivate(): PrivateSettings {
    return {
      discordWebhookUrl: this.store.getSetting(KEYS.webhook) ?? '',
      notificationChannel: normalizeChannel(this.store.getSetting(KEYS.channel)),
      pushplusToken: this.store.getSetting(KEYS.pushplusToken) ?? '',
      pushplusTopic: this.store.getSetting(KEYS.pushplusTopic) ?? '',
      proxyUrl: this.store.getSetting(KEYS.proxy) ?? '',
      useProxyForDiscord: (this.store.getSetting(KEYS.discordProxy) ?? '1') === '1',
      defaultCooldownSec: Number(this.store.getSetting(KEYS.cooldown) ?? DEFAULT_COOLDOWN_SEC),
      eventRetentionDays: Number(this.store.getSetting(KEYS.retention) ?? DEFAULT_RETENTION_DAYS),
    };
  }

  getPublic(): PublicSettings {
    const settings = this.getPrivate();
    return {
      discordConfigured: Boolean(settings.discordWebhookUrl),
      discordWebhookMasked: maskWebhook(settings.discordWebhookUrl),
      notificationChannel: settings.notificationChannel,
      notificationsConfigured: this.isNotificationConfigured(),
      pushplusConfigured: Boolean(settings.pushplusToken),
      pushplusTokenMasked: maskPushplusToken(settings.pushplusToken),
      pushplusTopic: settings.pushplusTopic,
      proxyUrl: settings.proxyUrl,
      useProxyForDiscord: settings.useProxyForDiscord,
      defaultCooldownSec: settings.defaultCooldownSec,
      eventRetentionDays: settings.eventRetentionDays,
      okxRestBase: this.config.okxRestBase,
      okxWsUrl: this.config.okxWsUrl,
      timezone: this.config.timezone,
    };
  }

  getProxyForMarket(): string {
    return this.getPrivate().proxyUrl;
  }

  getProxyForDiscord(): string {
    const settings = this.getPrivate();
    return settings.useProxyForDiscord ? settings.proxyUrl : '';
  }

  getProxyForPushplus(): string {
    return this.getPrivate().proxyUrl;
  }

  isNotificationConfigured(channel = this.getPrivate().notificationChannel): boolean {
    const settings = this.getPrivate();
    return channel === 'pushplus' ? Boolean(settings.pushplusToken) : Boolean(settings.discordWebhookUrl);
  }

  getPushplusToken(): string {
    return this.getPrivate().pushplusToken;
  }

  getPushplusTopic(): string {
    return this.getPrivate().pushplusTopic;
  }

  validateUpdate(input: unknown): { ok: true; value: SettingsUpdate } | { ok: false; errors: string[] } {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return { ok: false, errors: ['请求体格式错误'] };
    }
    const raw = input as Record<string, unknown>;
    const value: SettingsUpdate = {};
    const errors: string[] = [];
    if ('discordWebhookUrl' in raw) {
      if (raw.discordWebhookUrl === null) value.discordWebhookUrl = null;
      else if (typeof raw.discordWebhookUrl !== 'string') errors.push('Webhook URL 必须是字符串');
      else {
        const normalized = raw.discordWebhookUrl.trim();
        const invalid = validateDiscordWebhook(normalized);
        if (invalid) errors.push(invalid);
        else value.discordWebhookUrl = normalized;
      }
    }
    if ('notificationChannel' in raw) {
      if (typeof raw.notificationChannel !== 'string' || !NOTIFICATION_CHANNELS.includes(raw.notificationChannel as NotificationChannel)) {
        errors.push('通知渠道必须为 discord 或 pushplus');
      } else {
        value.notificationChannel = raw.notificationChannel as NotificationChannel;
      }
    }
    if ('pushplusToken' in raw) {
      if (raw.pushplusToken === null) value.pushplusToken = null;
      else if (typeof raw.pushplusToken !== 'string') errors.push('PushPlus Token 必须是字符串');
      else {
        const normalized = raw.pushplusToken.trim();
        const invalid = validatePushplusToken(normalized);
        if (invalid) errors.push(invalid);
        else value.pushplusToken = normalized;
      }
    }
    if ('pushplusTopic' in raw) {
      if (typeof raw.pushplusTopic !== 'string') errors.push('PushPlus 群组编码必须是字符串');
      else {
        const normalized = raw.pushplusTopic.trim();
        if (normalized.length > 64 || /[\r\n]/.test(normalized)) {
          errors.push('PushPlus 群组编码不能超过 64 个字符且不能包含换行');
        } else value.pushplusTopic = normalized;
      }
    }
    if ('proxyUrl' in raw) {
      if (typeof raw.proxyUrl !== 'string') errors.push('代理地址必须是字符串');
      else {
        const normalized = raw.proxyUrl.trim();
        const invalid = validateProxyUrl(normalized);
        if (invalid) errors.push(invalid);
        else value.proxyUrl = normalized;
      }
    }
    if ('useProxyForDiscord' in raw) {
      if (typeof raw.useProxyForDiscord !== 'boolean') errors.push('Discord 代理开关必须是布尔值');
      else value.useProxyForDiscord = raw.useProxyForDiscord;
    }
    if ('defaultCooldownSec' in raw) {
      const n = raw.defaultCooldownSec;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 86_400) {
        errors.push('默认冷却时间必须是 0–1440 分钟的整数');
      } else value.defaultCooldownSec = n;
    }
    if ('eventRetentionDays' in raw) {
      const n = raw.eventRetentionDays;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 3650) {
        errors.push('事件保留天数必须是 1–3650 的整数');
      } else value.eventRetentionDays = n;
    }
    if (errors.length) return { ok: false, errors };
    return { ok: true, value };
  }

  update(update: SettingsUpdate): SettingsUpdateResult {
    const current = this.getPrivate();
    const next: PrivateSettings = {
      discordWebhookUrl:
        update.discordWebhookUrl === undefined
          ? current.discordWebhookUrl
          : update.discordWebhookUrl === null
            ? ''
            : update.discordWebhookUrl,
      notificationChannel: update.notificationChannel ?? current.notificationChannel,
      pushplusToken:
        update.pushplusToken === undefined
          ? current.pushplusToken
          : update.pushplusToken === null
            ? ''
            : update.pushplusToken,
      pushplusTopic: update.pushplusTopic === undefined ? current.pushplusTopic : update.pushplusTopic,
      proxyUrl: update.proxyUrl === undefined ? current.proxyUrl : update.proxyUrl,
      useProxyForDiscord:
        update.useProxyForDiscord === undefined ? current.useProxyForDiscord : update.useProxyForDiscord,
      defaultCooldownSec:
        update.defaultCooldownSec === undefined ? current.defaultCooldownSec : update.defaultCooldownSec,
      eventRetentionDays:
        update.eventRetentionDays === undefined ? current.eventRetentionDays : update.eventRetentionDays,
    };
    this.store.transaction(() => {
      this.store.setSetting(KEYS.webhook, next.discordWebhookUrl);
      this.store.setSetting(KEYS.channel, next.notificationChannel);
      this.store.setSetting(KEYS.pushplusToken, next.pushplusToken);
      this.store.setSetting(KEYS.pushplusTopic, next.pushplusTopic);
      this.store.setSetting(KEYS.proxy, next.proxyUrl);
      this.store.setSetting(KEYS.discordProxy, next.useProxyForDiscord ? '1' : '0');
      this.store.setSetting(KEYS.cooldown, String(next.defaultCooldownSec));
      this.store.setSetting(KEYS.retention, String(next.eventRetentionDays));
    });
    return {
      settings: next,
      publicSettings: this.getPublic(),
      proxyChanged: next.proxyUrl !== current.proxyUrl,
      webhookChanged: next.discordWebhookUrl !== current.discordWebhookUrl,
      notificationChanged:
        next.notificationChannel !== current.notificationChannel ||
        next.pushplusToken !== current.pushplusToken ||
        next.pushplusTopic !== current.pushplusTopic,
    };
  }

  clearWebhook(): void {
    this.store.setSetting(KEYS.webhook, '');
  }
}
