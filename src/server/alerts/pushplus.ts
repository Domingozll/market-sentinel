import {
  type Comparator,
  type ConditionEvaluation,
  type EventView,
  SERIES_CATALOG,
} from '../../shared/types';
import type { NetworkContext } from '../network';
import { validatePushplusToken } from '../settings';

export const PUSHPLUS_ENDPOINT = 'https://www.pushplus.plus/send/';

const CMP_LABEL: Record<Comparator, string> = { gt: '>', gte: '≥', lt: '<', lte: '≤' };

export interface PushplusSendSuccess {
  ok: true;
  httpStatus: number;
  messageId: string | null;
}
export interface PushplusSendFailure {
  ok: false;
  httpStatus: number | null;
  retryable: boolean;
  error: string;
  retryAfterMs?: number;
}
export type PushplusSendResult = PushplusSendSuccess | PushplusSendFailure;

export interface PushplusTransport {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

export interface PushplusClientOptions {
  network: NetworkContext;
  getProxy: () => string;
  transport?: PushplusTransport;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function formatNumber(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 3 : 6;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value);
}

function formatTime(ms: number): string {
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

function formatCondition(condition: ConditionEvaluation): string {
  const left = SERIES_CATALOG[condition.leftSeries];
  const right = condition.rightSeries
    ? SERIES_CATALOG[condition.rightSeries].label
    : formatNumber(condition.rightValue ?? 0);
  return `${condition.truth ? '✓' : '✕'} ${condition.timeframe} ${left.label} ${CMP_LABEL[condition.cmp]} ${right}，实际 ${formatNumber(condition.leftValue ?? 0)}`;
}

export function buildEventContent(event: EventView): string {
  const closeLabel =
    event.triggerMode === 'intrabar'
      ? event.closeConfirmed === true
        ? '盘中触发（收盘已确认）'
        : event.closeConfirmed === false
          ? '盘中触发（收盘未确认）'
          : '盘中触发（尚未收盘）'
      : '收盘确认';
  const timeframes = [...new Set(event.conditions.map((condition) => condition.timeframe))].join(' + ');
  const lines = [
    `规则：${event.ruleName}`,
    `品种：${event.symbol}`,
    `周期：${timeframes || '—'}`,
    `触发时间：${formatTime(event.triggerAt)} CST`,
    `触发价：${formatNumber(event.price)}`,
    `触发模式：${closeLabel}`,
    '',
    '条件快照：',
    ...event.conditions.map(formatCondition),
  ];
  if (event.note) lines.push('', `备注：${event.note}`);
  lines.push('', `事件 ID：${event.id}`, '', 'OKX 公共行情 · 仅供信息参考，不构成投资建议。');
  return truncate(lines.join('\n'), 4000);
}

export function buildEventPayload(
  event: EventView,
  token: string,
  topic?: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    token,
    title: truncate(
      `行情哨兵 · ${event.triggerMode === 'intrabar' ? '盘中触发' : '触发'} · ${event.symbol}`,
      100,
    ),
    content: buildEventContent(event),
    template: 'txt',
    channel: 'wechat',
  };
  if (topic?.trim()) payload.topic = topic.trim();
  return payload;
}

export function buildTestPayload(token: string, now = Date.now(), topic?: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    token,
    title: '行情哨兵 · 测试消息',
    content: [
      '微信 PushPlus 配置成功。',
      '',
      `发送时间：${formatTime(now)} CST`,
      '数据源：OKX 公共行情',
      '',
      '这是一条测试消息，不是行情信号，也不会写入事件记录。',
    ].join('\n'),
    template: 'txt',
    channel: 'wechat',
  };
  if (topic?.trim()) payload.topic = topic.trim();
  return payload;
}

export class PushplusClient {
  private network: NetworkContext;
  private getProxy: () => string;
  private transport: PushplusTransport;

  constructor(options: PushplusClientOptions) {
    this.network = options.network;
    this.getProxy = options.getProxy;
    this.transport = options.transport ?? {
      fetch: (url, init) => this.network.fetch(url, init as RequestInit),
    };
  }

  async sendEvent(event: EventView, token: string, topic?: string): Promise<PushplusSendResult> {
    return this.send(token, buildEventPayload(event, token, topic));
  }

  async sendTest(token: string, topic?: string): Promise<PushplusSendResult> {
    return this.send(token, buildTestPayload(token, Date.now(), topic));
  }

  private async send(token: string, payload: Record<string, unknown>): Promise<PushplusSendResult> {
    if (!token.trim()) {
      return { ok: false, httpStatus: null, retryable: false, error: '未配置 PushPlus Token' };
    }
    const invalid = validatePushplusToken(token);
    if (invalid) {
      return { ok: false, httpStatus: null, retryable: false, error: invalid };
    }
    this.network.updateProxy(this.getProxy());
    try {
      const response = await this.transport.fetch(PUSHPLUS_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'MarketSentinel/1.0',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      let body: { code?: number; msg?: string; data?: unknown } = {};
      try {
        body = text ? (JSON.parse(text) as typeof body) : {};
      } catch {
        // PushPlus or a proxy may return an HTML error page.
      }
      if (response.ok && (body.code === 200 || body.code === 0)) {
        return {
          ok: true,
          httpStatus: response.status,
          messageId: body.data === undefined || body.data === null ? null : String(body.data).slice(0, 200),
        };
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      const retryable = response.status === 429 || response.status >= 500;
      const detail = body.msg ? `：${body.msg}` : '';
      return {
        ok: false,
        httpStatus: response.status,
        retryable,
        error: this.safeError(
          `PushPlus HTTP ${response.status}${body.code !== undefined ? ` / code ${body.code}` : ''}${detail}`,
          token,
        ),
        retryAfterMs: retryable && Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      };
    } catch (error) {
      return {
        ok: false,
        httpStatus: null,
        retryable: true,
        error: this.safeError(error instanceof Error ? error.message : String(error), token),
      };
    }
  }

  private safeError(message: string, token: string): string {
    return message.replaceAll(token, '***').slice(0, 800);
  }
}
