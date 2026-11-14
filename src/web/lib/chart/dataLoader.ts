import type { DataLoader, DataLoaderGetBarsParams, DataLoaderSubscribeBarParams, KLineData } from 'klinecharts';
import type { Candle } from '../../../shared/types';
import { api } from '../../api';
import { INITIAL_CHART_BARS, MAX_CHART_BARS } from './types';

export interface ChartDataContext {
  symbol: string;
  timeframe: string;
  onError?: (error: unknown) => void;
  onStatus?: (status: 'connecting' | 'live' | 'polling' | 'offline') => void;
  onDataChange?: () => void;
}

export function toKLineData(candle: Candle): KLineData {
  return {
    timestamp: candle.openTime,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volCcyQuote,
    turnover: candle.volCcyQuote,
  };
}

export function normalizeBars(candles: Candle[]): KLineData[] {
  const map = new Map<number, KLineData>();
  for (const candle of candles) {
    if (
      !Number.isFinite(candle.openTime) ||
      !Number.isFinite(candle.open) ||
      !Number.isFinite(candle.high) ||
      !Number.isFinite(candle.low) ||
      !Number.isFinite(candle.close)
    ) {
      continue;
    }
    map.set(candle.openTime, toKLineData(candle));
  }
  return [...map.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * KLineChart v10 data loader: REST history + SSE realtime, polling fallback.
 * Kept outside React state so ticks never trigger component re-renders.
 */
export class ChartDataLoader {
  private context: ChartDataContext;
  private generation = 0;
  private controller: AbortController | null = null;
  private eventSource: EventSource | null = null;
  private pollTimer: number | null = null;
  private sseErrors = 0;
  private destroyed = false;
  private loadedBars = 0;
  private barCallback: ((bar: KLineData) => void) | null = null;

  constructor(context: ChartDataContext) {
    this.context = context;
  }

  get loader(): DataLoader {
    return {
      getBars: (params) => {
        void this.getBars(params);
      },
      subscribeBar: (params) => {
        this.subscribeBar(params);
      },
      unsubscribeBar: () => {
        this.stopRealtime();
      },
    };
  }

  updateContext(context: ChartDataContext): void {
    this.context = context;
  }

  destroy(): void {
    this.destroyed = true;
    this.stopRealtime();
    this.controller?.abort();
    this.controller = null;
  }

  private async getBars({ type, timestamp, callback }: DataLoaderGetBarsParams): Promise<void> {
    if (this.destroyed) return;
    if (type === 'backward') {
      callback([], { forward: false, backward: false });
      return;
    }
    if (type === 'forward' && this.loadedBars >= MAX_CHART_BARS) {
      callback([], { forward: false, backward: false });
      return;
    }
    const generation = ++this.generation;
    this.controller?.abort();
    this.controller = new AbortController();
    const before = type === 'forward' ? timestamp ?? undefined : undefined;
    if (type === 'forward' && before === undefined) {
      callback([], { forward: false, backward: false });
      return;
    }
    try {
      const page = await api.candlesPage({
        instId: this.context.symbol,
        timeframe: this.context.timeframe,
        limit: type === 'init' ? INITIAL_CHART_BARS : 500,
        before,
      });
      if (this.destroyed || generation !== this.generation) return;
      const bars = normalizeBars(page.candles);
      if (type === 'init') this.loadedBars = bars.length;
      else this.loadedBars += bars.length;
      callback(bars, {
        forward: page.page.hasMore && this.loadedBars < MAX_CHART_BARS,
        backward: false,
      });
      this.context.onDataChange?.();
    } catch (error) {
      if (this.destroyed || generation !== this.generation) return;
      callback([], { forward: false, backward: false });
      this.context.onError?.(error);
    }
  }

  private subscribeBar({ symbol, period, callback }: DataLoaderSubscribeBarParams): void {
    if (this.destroyed) return;
    void symbol;
    void period;
    this.stopRealtime();
    this.barCallback = callback;
    this.sseErrors = 0;
    this.context.onStatus?.('connecting');
    this.openStream();
  }

  private openStream(): void {
    if (typeof EventSource === 'undefined') {
      this.startPolling();
      return;
    }
    const stream = new EventSource(
      api.candlesStreamUrl(this.context.symbol, this.context.timeframe),
    );
    this.eventSource = stream;
    stream.addEventListener('open', () => {
      this.sseErrors = 0;
      this.context.onStatus?.('live');
    });
    stream.addEventListener('candle', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { candle?: Candle };
        if (!payload.candle) return;
        const bars = normalizeBars([payload.candle]);
        if (!bars.length) return;
        this.barCallback?.(bars[0]);
        this.context.onDataChange?.();
      } catch (error) {
        this.context.onError?.(error);
      }
    });
    stream.addEventListener('error', () => {
      this.sseErrors += 1;
      if (this.sseErrors < 3) return;
      this.context.onError?.(new Error('实时 K 线连接中断，已切换为轮询'));
      this.closeStream();
      this.startPolling();
    });
  }

  private closeStream(): void {
    this.eventSource?.close();
    this.eventSource = null;
  }

  private startPolling(): void {
    this.closeStream();
    this.context.onStatus?.('polling');
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    const poll = async (): Promise<void> => {
      if (this.destroyed) return;
      try {
        const response = await api.candlesPage({
          instId: this.context.symbol,
          timeframe: this.context.timeframe,
          limit: 2,
        });
        const bars = normalizeBars(response.candles);
        const last = bars.at(-1);
        if (last) {
          this.barCallback?.(last);
          this.context.onDataChange?.();
        }
      } catch (error) {
        this.context.onError?.(error);
      }
    };
    void poll();
    this.pollTimer = window.setInterval(() => void poll(), 2_000);
  }

  private stopRealtime(): void {
    this.barCallback = null;
    this.closeStream();
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
