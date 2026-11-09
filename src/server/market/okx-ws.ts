import WebSocket from 'ws';
import type { Timeframe } from '../../shared/types';
import { TF_TO_OKX_BAR } from '../../shared/types';
import type { NetworkContext } from '../network';

export interface WsSubscription {
  instId: string;
  timeframe: Timeframe;
}

export interface OkxWsOptions {
  url: string;
  network: NetworkContext;
  getProxy: () => string;
  onCandle: (instId: string, timeframe: Timeframe, row: string[]) => void;
  onState: (state: 'connected' | 'disconnected' | 'connecting', reconnected: boolean) => void;
  onError: (error: Error) => void;
}

interface WsMessage {
  event?: string;
  arg?: { channel?: string; instId?: string };
  data?: unknown;
  msg?: string;
  code?: string;
}

const CHANNEL_TO_TF: Record<string, Timeframe> = {
  candle1m: '1m',
  candle3m: '3m',
  candle5m: '5m',
  candle15m: '15m',
  candle30m: '30m',
  candle1H: '1H',
  candle2H: '2H',
  candle4H: '4H',
  candle1D: '1D',
};

export class OkxWsClient {
  private options: OkxWsOptions;
  private ws: WebSocket | null = null;
  private subscriptions = new Map<string, WsSubscription>();
  private activeKeys = new Set<string>();
  private state: 'idle' | 'connecting' | 'connected' | 'disconnected' = 'idle';
  private stopped = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastMessageAt = 0;
  private everConnected = false;

  constructor(options: OkxWsOptions) {
    this.options = options;
  }

  getState(): string {
    return this.state;
  }

  getLastMessageAt(): number {
    return this.lastMessageAt;
  }

  async setSubscriptions(subs: WsSubscription[]): Promise<void> {
    const next = new Map<string, WsSubscription>();
    for (const sub of subs) {
      next.set(`${sub.instId}|${sub.timeframe}`, sub);
    }
    this.subscriptions = next;
    if (this.subscriptions.size === 0) {
      this.activeKeys.clear();
      if (this.ws) {
        this.ws.close(1000, 'No subscriptions');
      }
      return;
    }
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      this.connect();
      return;
    }
    if (this.ws.readyState === WebSocket.OPEN) {
      this.syncSubscriptions();
    }
  }

  private connect(): void {
    if (this.stopped) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.cleanupSocket();
    this.state = 'connecting';
    this.options.onState('connecting', this.everConnected);
    this.options.network.updateProxy(this.options.getProxy());
    const agent = this.options.network.getWebSocketAgent();
    const ws = new WebSocket(this.options.url, {
      ...(agent ? { agent } : {}),
      handshakeTimeout: 15_000,
      perMessageDeflate: false,
    });
    this.ws = ws;
    this.lastMessageAt = Date.now();

    ws.on('open', () => {
      if (this.ws !== ws) return;
      const reconnected = this.everConnected;
      this.everConnected = true;
      this.state = 'connected';
      this.reconnectAttempts = 0;
      this.lastMessageAt = Date.now();
      this.activeKeys.clear();
      this.syncSubscriptions();
      this.startHeartbeat();
      this.options.onState('connected', reconnected);
    });

    ws.on('message', (data, isBinary) => {
      if (this.ws !== ws) return;
      this.lastMessageAt = Date.now();
      if (isBinary) return;
      const text = data.toString();
      if (text === 'pong') return;
      let message: WsMessage;
      try {
        message = JSON.parse(text) as WsMessage;
      } catch {
        return;
      }
      if (message.event === 'error') {
        this.options.onError(new Error(`OKX WebSocket 错误 ${message.code ?? ''}: ${message.msg ?? 'unknown'}`));
        return;
      }
      if (message.event === 'notice') {
        this.options.onError(new Error(`OKX WebSocket 通知 ${message.code ?? ''}: ${message.msg ?? ''}`));
        return;
      }
      if (!message.arg?.channel || !message.arg.instId || !Array.isArray(message.data)) return;
      const timeframe = CHANNEL_TO_TF[message.arg.channel];
      if (!timeframe) return;
      for (const row of message.data) {
        if (Array.isArray(row)) {
          this.options.onCandle(message.arg.instId, timeframe, row.map((v) => String(v)));
        }
      }
    });

    ws.on('pong', () => {
      this.lastMessageAt = Date.now();
    });

    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.onDisconnected();
    });

    ws.on('error', (error) => {
      this.options.onError(error instanceof Error ? error : new Error(String(error)));
      // close event handles reconnection
    });
  }

  private syncSubscriptions(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const desiredKeys = new Set(this.subscriptions.keys());
    const toUnsubscribe = [...this.activeKeys].filter((key) => !desiredKeys.has(key));
    const toSubscribe = [...desiredKeys].filter((key) => !this.activeKeys.has(key));

    if (toUnsubscribe.length) {
      const args = toUnsubscribe.map((key) => {
        const sub = this.parseKey(key);
        return { channel: `candle${TF_TO_OKX_BAR[sub.timeframe]}`, instId: sub.instId };
      });
      this.ws.send(JSON.stringify({ op: 'unsubscribe', args }));
      for (const key of toUnsubscribe) this.activeKeys.delete(key);
    }
    if (toSubscribe.length) {
      const args = toSubscribe.map((key) => {
        const sub = this.parseKey(key);
        return { channel: `candle${TF_TO_OKX_BAR[sub.timeframe]}`, instId: sub.instId };
      });
      // OKX accepts multiple args; chunk to keep individual frames small.
      for (let i = 0; i < args.length; i += 50) {
        this.ws.send(JSON.stringify({ op: 'subscribe', args: args.slice(i, i + 50) }));
      }
      for (const key of toSubscribe) this.activeKeys.add(key);
    }
  }

  private parseKey(key: string): WsSubscription {
    const separator = key.lastIndexOf('|');
    return {
      instId: key.slice(0, separator),
      timeframe: key.slice(separator + 1) as Timeframe,
    };
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastMessageAt > 45_000) {
        this.options.onError(new Error('OKX WebSocket 心跳超时，准备重连'));
        this.ws.terminate();
        return;
      }
      try {
        this.ws.send('ping');
      } catch {
        // The close handler will reconnect.
      }
    }, 20_000);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private onDisconnected(): void {
    this.state = 'disconnected';
    this.cleanupSocket();
    this.options.onState('disconnected', this.everConnected);
    if (this.stopped || this.subscriptions.size === 0) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.reconnectAttempts) + Math.floor(Math.random() * 400);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private cleanupSocket(): void {
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.terminate();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.activeKeys.clear();
  }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.cleanupSocket();
    this.state = 'idle';
  }
}
