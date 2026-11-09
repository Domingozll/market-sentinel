import { EventEmitter } from 'node:events';
import {
  type Candle,
  type MarketPairStatus,
  type Timeframe,
  type Timeframe as TF,
  MIN_HISTORY_BARS,
  TF_MS,
} from '../../src/shared/types';
import type { AppMarket, InstrumentInfo, PairRef } from '../../src/server/market/provider';
import { pairKey } from '../../src/server/market/provider';
import {
  expectedLatestClosedOpen,
  hasContinuousCandles,
  isLatestClosedBarFresh,
} from '../../src/server/market/time';

export interface CandleFactoryOptions {
  instId: string;
  timeframe: Timeframe;
  count: number;
  endCloseTime: number;
  basePrice?: number;
  drift?: number;
}

export function makeCandles(options: CandleFactoryOptions): Candle[] {
  const { instId, timeframe, count, endCloseTime } = options;
  const tf = TF_MS[timeframe];
  const base = options.basePrice ?? 100;
  const drift = options.drift ?? 0.04;
  const startOpen = endCloseTime - count * tf;
  const candles: Candle[] = [];
  let previousClose = base;
  for (let i = 0; i < count; i++) {
    const wave = Math.sin(i / 7) * 0.7 + Math.cos(i / 13) * 0.35;
    const close = base + i * drift + wave;
    const open = previousClose;
    const high = Math.max(open, close) + 0.35;
    const low = Math.min(open, close) - 0.35;
    const volume = 1000 + ((i * 37) % 400) + (i % 11 === 0 ? 900 : 0);
    candles.push({
      instId,
      timeframe,
      openTime: startOpen + i * tf,
      open,
      high,
      low,
      close,
      volume,
      vol: volume / 10,
      volCcy: volume / 10,
      volCcyQuote: volume,
      confirm: true,
    });
    previousClose = close;
  }
  return candles;
}

export function makeCandle(options: {
  instId: string;
  timeframe: Timeframe;
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  confirm?: boolean;
}): Candle {
  return {
    instId: options.instId,
    timeframe: options.timeframe,
    openTime: options.openTime,
    open: options.open,
    high: options.high,
    low: options.low,
    close: options.close,
    volume: options.volume ?? 1000,
    vol: (options.volume ?? 1000) / 10,
    volCcy: (options.volume ?? 1000) / 10,
    volCcyQuote: options.volume ?? 1000,
    confirm: options.confirm ?? true,
  };
}

interface FakePair {
  candles: Candle[];
  forming: Candle | null;
  ready: boolean;
}

export class FakeMarket extends EventEmitter implements AppMarket {
  private nowMs: number;
  private pairs = new Map<string, FakePair>();
  private history = new Map<string, Candle[]>();
  private startedAt = Date.now();
  private errors: { at: number; message: string }[] = [];
  private connected = true;

  constructor(nowMs = Date.now()) {
    super();
    this.nowMs = nowMs;
  }

  setNow(nowMs: number): void {
    this.nowMs = nowMs;
  }

  exchangeNow(): number {
    return this.nowMs;
  }

  private state(instId: string, timeframe: Timeframe): FakePair {
    const key = pairKey(instId, timeframe);
    let state = this.pairs.get(key);
    if (!state) {
      state = { candles: [], forming: null, ready: false };
      this.pairs.set(key, state);
    }
    return state;
  }

  seed(instId: string, timeframe: Timeframe, candles: Candle[], options: { ready?: boolean } = {}): void {
    const state = this.state(instId, timeframe);
    state.candles = candles.filter((c) => c.confirm).slice().sort((a, b) => a.openTime - b.openTime);
    state.ready = options.ready ?? true;
    if (state.ready) this.emit('ready', { instId, timeframe });
  }

  setHistory(instId: string, timeframe: Timeframe, candles: Candle[]): void {
    this.history.set(pairKey(instId, timeframe), candles.slice().sort((a, b) => a.openTime - b.openTime));
  }

  async ensurePairs(pairs: PairRef[]): Promise<void> {
    for (const pair of pairs) {
      const state = this.state(pair.instId, pair.timeframe);
      if (state.candles.length && !state.ready) {
        state.ready = true;
        this.emit('ready', pair);
      }
    }
    this.emit('status', this.listPairStatuses());
  }

  getClosedCandles(instId: string, timeframe: Timeframe, limit = 300): Candle[] {
    return this.state(instId, timeframe).candles.slice(-limit);
  }

  getCandlesIncludingForming(instId: string, timeframe: Timeframe, limit = 300): Candle[] {
    const state = this.state(instId, timeframe);
    return [...state.candles, ...(state.forming ? [state.forming] : [])].slice(-limit);
  }

  getLatestClosed(instId: string, timeframe: Timeframe): Candle | null {
    return this.state(instId, timeframe).candles.at(-1) ?? null;
  }

  isFresh(instId: string, timeframe: Timeframe, now = this.nowMs): boolean {
    return isLatestClosedBarFresh(this.getLatestClosed(instId, timeframe), now);
  }

  hasContinuousHistory(instId: string, timeframe: Timeframe): boolean {
    const candles = this.state(instId, timeframe).candles;
    return candles.length >= MIN_HISTORY_BARS && hasContinuousCandles(candles, MIN_HISTORY_BARS);
  }

  getPairStatus(instId: string, timeframe: Timeframe): MarketPairStatus {
    const state = this.state(instId, timeframe);
    const latest = state.candles.at(-1) ?? null;
    const stateName: MarketPairStatus['state'] = state.candles.length < MIN_HISTORY_BARS
      ? 'warming'
      : isLatestClosedBarFresh(latest, this.nowMs)
        ? 'healthy'
        : 'stale';
    return {
      instId,
      timeframe,
      state: stateName,
      latestClosedOpen: latest?.openTime ?? null,
      latestClosedAt: latest ? latest.openTime + TF_MS[timeframe] : null,
      lastReceivedAt: this.nowMs,
      bars: state.candles.length,
    };
  }

  listPairStatuses(): MarketPairStatus[] {
    return [...this.pairs.entries()].map(([key, state]) => {
      const [instId, timeframe] = key.split('|') as [string, Timeframe];
      return {
        instId,
        timeframe,
        state: state.candles.length < MIN_HISTORY_BARS ? 'warming' : isLatestClosedBarFresh(state.candles.at(-1), this.nowMs) ? 'healthy' : 'stale',
        latestClosedOpen: state.candles.at(-1)?.openTime ?? null,
        latestClosedAt: state.candles.at(-1) ? state.candles.at(-1)!.openTime + TF_MS[timeframe] : null,
        lastReceivedAt: this.nowMs,
        bars: state.candles.length,
      };
    });
  }

  pushClosed(candle: Candle): void {
    const state = this.state(candle.instId, candle.timeframe);
    if (!state.candles.length || candle.openTime > state.candles.at(-1)!.openTime) {
      state.candles.push(candle);
      this.nowMs = Math.max(this.nowMs, candle.openTime + TF_MS[candle.timeframe] + 3000);
      this.emit('closed', candle, 'ws');
    }
  }

  pushTick(candle: Candle): void {
    const state = this.state(candle.instId, candle.timeframe);
    state.forming = candle;
    this.emit('tick', candle);
  }

  getInstruments(query = ''): Promise<InstrumentInfo[]> {
    const instruments = [
      { instId: 'BTC-USDT-SWAP', instType: 'SWAP', state: 'live' },
      { instId: 'ETH-USDT-SWAP', instType: 'SWAP', state: 'live' },
      { instId: 'BTC-USDT', instType: 'SPOT', state: 'live' },
    ];
    const q = query.toUpperCase();
    return Promise.resolve(q ? instruments.filter((item) => item.instId.includes(q)) : instruments);
  }

  async fetchHistory(instId: string, timeframe: TF, from: number, now = this.nowMs): Promise<Candle[]> {
    const history = this.history.get(pairKey(instId, timeframe)) ?? this.getClosedCandles(instId, timeframe, 100000);
    return history.filter((c) => c.openTime >= from && c.openTime + TF_MS[timeframe] <= now);
  }

  async testConnection(): Promise<{ ok: boolean; latencyMs: number; serverNow: number }> {
    return { ok: true, latencyMs: 12, serverNow: this.nowMs };
  }

  getRecentErrors(): { at: number; message: string }[] {
    return [...this.errors];
  }

  getClockOffset(): number {
    return 0;
  }

  isWsConnected(): boolean {
    return this.connected;
  }

  getConnectionState(): 'connected' | 'disconnected' {
    return this.connected ? 'connected' : 'disconnected';
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    this.emit('status', this.listPairStatuses());
  }

  getLastMessageAt(): number | null {
    return this.nowMs;
  }

  getStartedAt(): number {
    return this.startedAt;
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  emitResync(pairs: PairRef[]): void {
    this.emit('resync', pairs);
  }

  addError(message: string): void {
    this.errors.push({ at: this.nowMs, message });
  }
}

export const wait = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function expectedFreshTime(lastClose: number): number {
  return lastClose + 5000;
}

export { expectedLatestClosedOpen };
