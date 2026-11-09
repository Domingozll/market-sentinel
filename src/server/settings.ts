import type { AppConfig } from './config';
import type { Store } from './store';
import type { PublicSettings } from '../shared/types';
import { DEFAULT_COOLDOWN_SEC, DEFAULT_RETENTION_DAYS } from '../shared/types';
import { validateProxyUrl } from './network';

export interface PrivateSettings {
  discordWebhookUrl: string;
  proxyUrl: string;
  useProxyForDiscord: boolean;
  defaultCooldownSec: number;
  eventRetentionDays: number;
}

export interface SettingsUpdate {
  discordWebhookUrl?: string | null;
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
}

const KEYS = {
  webhook: 'discord_webhook_url',
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
    };
  }

  clearWebhook(): void {
    this.store.setSetting(KEYS.webhook, '');
  }
}
