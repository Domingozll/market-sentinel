import {
  type Comparator,
  type ConditionEvaluation,
  type EventView,
  type TriggerMode,
  SERIES_CATALOG,
} from '../../shared/types';
import type { NetworkContext } from '../network';
import { validateDiscordWebhook } from '../settings';

const COLORS = {
  close: 0x31d7c2,
  intrabar: 0xefb45d,
};

const CMP_LABEL: Record<Comparator, string> = { gt: '>', gte: '≥', lt: '<', lte: '≤' };

export interface DiscordSendSuccess {
  ok: true;
  httpStatus: number;
  messageId: string | null;
}
export interface DiscordSendFailure {
  ok: false;
  httpStatus: number | null;
  retryable: boolean;
  error: string;
  retryAfterMs?: number;
}
export type DiscordSendResult = DiscordSendSuccess | DiscordSendFailure;

export interface DiscordTransport {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

export interface DiscordClientOptions {
  network: NetworkContext;
  getProxy: () => string;
  transport?: DiscordTransport;
  /** Tests only. Production must never enable this. */
  allowNonOfficialUrls?: boolean;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function formatNumber(value: number): string {
  const abs = Math.abs(value);
  const maximumFractionDigits = abs >= 1000 ? 2 : abs >= 1 ? 3 : 6;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits }).format(value);
}

function formatCondition(condition: ConditionEvaluation): string {
  const leftMeta = SERIES_CATALOG[condition.leftSeries];
  const right = condition.rightSeries
    ? SERIES_CATALOG[condition.rightSeries].label
    : formatNumber(condition.rightValue ?? 0);
  const unit = leftMeta.unit === 'percentPerBar' ? '%/根' : '';
  return `${condition.truth ? '✓' : '✕'} ${condition.timeframe} ${leftMeta.label} ${
    CMP_LABEL[condition.cmp]
  } ${right}  ·  实际 ${formatNumber(condition.leftValue ?? 0)}${unit}`;
}

export function formatTriggerTime(ms: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .format(new Date(ms))
    .replace(/\//g, '-');
}

export function buildEventPayload(event: EventView): Record<string, unknown> {
  const conditionText = event.conditions.map(formatCondition).join('\n');
  const closeLabel =
    event.triggerMode === 'intrabar'
      ? event.closeConfirmed === true
        ? '盘中触发 · 已收盘确认'
        : event.closeConfirmed === false
          ? '盘中触发 · 收盘未确认'
          : '盘中触发 · 未收盘，可能失效'
      : '收盘确认';
  const fields = [
    {
      name: '规则',
      value: truncate(event.ruleName, 256),
      inline: true,
    },
    {
      name: '触发模式',
      value: closeLabel,
      inline: true,
    },
    {
      name: '触发时间',
      value: `${formatTriggerTime(event.triggerAt)} CST`,
      inline: true,
    },
    {
      name: '触发价',
      value: formatNumber(event.price),
      inline: true,
    },
    {
      name: '条件快照',
      value: truncate(conditionText || '—', 1024),
      inline: false,
    },
  ];
  if (event.note) {
    fields.push({ name: '备注', value: truncate(event.note, 500), inline: false });
  }
  fields.push({
    name: '事件 ID',
    value: `\`${event.id}\``,
    inline: false,
  });
  return {
    username: '行情哨兵',
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: truncate(
          `${event.triggerMode === 'intrabar' ? '📡 盘中触发' : '📡 触发'} · ${event.symbol}`,
          256,
        ),
        color: COLORS[event.triggerMode as TriggerMode],
        timestamp: new Date(event.triggerAt).toISOString(),
        fields,
        footer: {
          text: 'OKX 公共行情 · 仅供信息参考，不构成投资建议',
        },
      },
    ],
  };
}

export function buildTestPayload(now = Date.now()): Record<string, unknown> {
  return {
    username: '行情哨兵',
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: '✅ 行情哨兵 · 测试消息',
        color: COLORS.close,
        timestamp: new Date(now).toISOString(),
        description:
          'Discord Webhook 配置成功。这是一条测试消息，不是行情信号，也不会写入事件记录。',
        fields: [
          { name: '发送时间', value: `${formatTriggerTime(now)} CST`, inline: true },
          { name: '数据源', value: 'OKX 公共行情', inline: true },
        ],
        footer: { text: '仅提醒，不构成投资建议' },
      },
    ],
  };
}

export class DiscordClient {
  private network: NetworkContext;
  private getProxy: () => string;
  private transport: DiscordTransport;
  private allowNonOfficialUrls: boolean;

  constructor(options: DiscordClientOptions) {
    this.network = options.network;
    this.getProxy = options.getProxy;
    this.allowNonOfficialUrls = options.allowNonOfficialUrls ?? false;
    this.transport = options.transport ?? {
      fetch: (url, init) => this.network.fetch(url, init as RequestInit),
    };
  }

  private checkUrl(url: string): string | null {
    if (!url.trim()) return '未配置 Discord Webhook';
    if (this.allowNonOfficialUrls) return null;
    return validateDiscordWebhook(url);
  }

  async sendEvent(event: EventView, webhookUrl: string): Promise<DiscordSendResult> {
    return this.send(webhookUrl, buildEventPayload(event));
  }

  async sendTest(webhookUrl: string): Promise<DiscordSendResult> {
    return this.send(webhookUrl, buildTestPayload());
  }

  private async send(webhookUrl: string, payload: Record<string, unknown>): Promise<DiscordSendResult> {
    const invalid = this.checkUrl(webhookUrl);
    if (invalid) {
      return { ok: false, httpStatus: null, retryable: false, error: invalid };
    }
    const url = new URL(webhookUrl);
    url.searchParams.set('wait', 'true');
    this.network.updateProxy(this.getProxy());
    try {
      const response = await this.transport.fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'MarketSentinel/1.0',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      let body: { id?: string; message?: string; retry_after?: number } = {};
      try {
        body = text ? (JSON.parse(text) as typeof body) : {};
      } catch {
        // Discord may return an HTML proxy error page.
      }
      if (response.ok) {
        return { ok: true, httpStatus: response.status, messageId: body.id ?? null };
      }
      const retryAfter = Number(response.headers.get('retry-after') ?? body.retry_after);
      const retryable = response.status === 429 || response.status >= 500;
      return {
        ok: false,
        httpStatus: response.status,
        retryable,
        error: this.safeError(`Discord HTTP ${response.status}${body.message ? `：${body.message}` : ''}`),
        retryAfterMs: retryable && Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      };
    } catch (error) {
      return {
        ok: false,
        httpStatus: null,
        retryable: true,
        error: this.safeError(error instanceof Error ? error.message : String(error)),
      };
    }
  }

  private safeError(message: string): string {
    return message
      .replace(/\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g, '/api/webhooks/***')
      .replace(/https?:\/\/[^\s]*discord[^\s]*/gi, 'https://discord.com/api/webhooks/***')
      .slice(0, 800);
  }
}
