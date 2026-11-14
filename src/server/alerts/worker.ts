import { EventEmitter } from 'node:events';
import type { EventView } from '../../shared/types';
import type { Store } from '../store';
import type { DiscordClient } from './discord';
import type { PushplusClient } from './pushplus';

export interface DeliveryWorkerOptions {
  store: Store;
  discord: DiscordClient;
  getWebhookUrl: () => string;
  pushplus?: PushplusClient;
  getPushplusToken?: () => string;
  getPushplusTopic?: () => string;
  pollIntervalMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number[];
  minBackoffMs?: number;
}

export class DeliveryWorker extends EventEmitter {
  private store: Store;
  private discord: DiscordClient;
  private getWebhookUrl: () => string;
  private pushplus?: PushplusClient;
  private getPushplusToken?: () => string;
  private getPushplusTopic?: () => string;
  private pollIntervalMs: number;
  private maxAttempts: number;
  private baseBackoffMs: number[];
  private minBackoffMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private processing = false;
  private stopped = false;
  private wakeResolve: (() => void) | null = null;

  constructor(options: DeliveryWorkerOptions) {
    super();
    this.store = options.store;
    this.discord = options.discord;
    this.getWebhookUrl = options.getWebhookUrl;
    this.pushplus = options.pushplus;
    this.getPushplusToken = options.getPushplusToken;
    this.getPushplusTopic = options.getPushplusTopic;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.maxAttempts = options.maxAttempts ?? 6;
    this.baseBackoffMs = options.baseBackoffMs ?? [30_000, 120_000, 300_000, 900_000, 3_600_000];
    this.minBackoffMs = options.minBackoffMs ?? 1000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.store.resetInflightDeliveries();
    this.timer = setInterval(() => {
      void this.processOnce();
    }, this.pollIntervalMs);
    this.timer.unref?.();
    void this.processOnce();
  }

  wake(): void {
    if (this.wakeResolve) this.wakeResolve();
    void this.processOnce();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.wakeResolve) this.wakeResolve();
    // Wait for an in-flight send to finish (bounded by the HTTP timeout).
    while (this.processing) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  async processOnce(): Promise<void> {
    if (this.processing || this.stopped) return;
    this.processing = true;
    try {
      const due = this.store.listDueDeliveries(Date.now(), 10);
      for (const event of due) {
        if (this.stopped) break;
        await this.processDelivery(event);
      }
    } finally {
      this.processing = false;
    }
  }

  private async processDelivery(event: EventView): Promise<void> {
    if (!this.store.claimDelivery(event.id)) return;
    const channel = event.delivery?.channel ?? 'discord';
    let result: { ok: boolean; httpStatus: number | null; retryable?: boolean; error?: string; messageId?: string | null; retryAfterMs?: number };
    try {
      if (channel === 'pushplus') {
        const token = this.getPushplusToken?.() ?? '';
        if (!this.pushplus || !token) {
          this.fail(event, '未配置 PushPlus Token', false, null);
          return;
        }
        result = await this.pushplus.sendEvent(event, token, this.getPushplusTopic?.() ?? '');
      } else {
        const webhookUrl = this.getWebhookUrl();
        if (!webhookUrl) {
          this.fail(event, '未配置 Discord Webhook', false, null);
          return;
        }
        result = await this.discord.sendEvent(event, webhookUrl);
      }
    } catch (error) {
      result = {
        ok: false,
        httpStatus: null,
        retryable: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (result.ok) {
      this.store.markDeliverySent(event.id, result.messageId ?? null);
      this.emit('deliveryUpdated', this.store.getEvent(event.id));
      return;
    }
    const attempts = (event.delivery?.attempts ?? 0) + 1;
    const retryable = result.retryable ?? true;
    const message = result.error ?? '通知发送失败';
    if (!retryable || attempts >= this.maxAttempts) {
      this.fail(event, message, retryable, result.httpStatus ?? null);
      return;
    }
    const backoff = result.retryAfterMs ?? this.baseBackoffMs[Math.min(attempts - 1, this.baseBackoffMs.length - 1)];
    this.store.markDeliveryFailure(
      event.id,
      'pending',
      message,
      result.httpStatus ?? null,
      Date.now() + Math.max(this.minBackoffMs, backoff),
    );
    this.emit('deliveryUpdated', this.store.getEvent(event.id));
  }

  private fail(event: EventView, message: string, _retryable: boolean, httpStatus: number | null): void {
    this.store.markDeliveryFailure(event.id, 'dead', message, httpStatus, null);
    this.emit('deliveryUpdated', this.store.getEvent(event.id));
    if (process.env.NODE_ENV !== 'test') {
      console.error('[delivery] failed', event.id, message);
    }
  }
}
