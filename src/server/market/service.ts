import { EventEmitter } from 'node:events';
import {
  type Candle,
  type MarketPairStatus,
  type Timeframe,
  TF_MS,
} from '../../shared/types';
import { MIN_HISTORY_BARS } from '../../shared/types';
import type { AppConfig } from '../config';
import type { Store } from '../store';
import { NetworkContext, sleep } from '../network';
import type { MarketConnectionState, MarketDataProvider, PairRef } from './provider';
import { pairKey } from './provider';
import { OkxRestClient, type OkxInstrument } from './okx-rest';
import { OkxWsClient } from './okx-ws';
import {
  candleCloseTime,
  expectedLatestClosedOpen,
  hasContinuousCandles,
  isLatestClosedBarFresh,
} from './time';

interface PairState {
  instId: string;
  timeframe: Timeframe;
  candles: Candle[];
  forming: Candle | null;
  lastReceivedAt: number | null;
  status: MarketPairStatus['state'];
  initialized: boolean;
  initializing: Promise<void> | null;
  lastError: string | null;
}

export interface MarketServiceOptions {
  config: AppConfig;
  store: Store;
  rest: OkxRestClient;
  network: NetworkContext;
  getProxy: () => string;
}

export class MarketService extends EventEmitter implements MarketDataProvider {
  private config: AppConfig;
  private store: Store;
  private rest: OkxRestClient;
  private network: NetworkContext;
  private getProxy: () => string;
  private pairs = new Map<string, PairState>();
  private desired = new Map<string, PairRef>();
  private ws: OkxWsClient;
  private wsConnected = false;
  private wsState: MarketConnectionState = 'idle';
  private lastMessageAt: number | null = null;
  private clockOffsetMs = 0;
  private lastClockSync = 0;
  private clockTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private reconcileRunning = false;
  private stopped = false;
  private startedAt = Date.now();
  private reconnecting = false;
  private resyncing = false;
  private recentErrors: { at: number; message: string }[] = [];

  constructor(options: MarketServiceOptions) {
    super();
    this.config = options.config;
    this.store = options.store;
    this.rest = options.rest;
    this.network = options.network;
    this.getProxy = options.getProxy;
    this.ws = this.createWsClient();
  }

  private createWsClient(): OkxWsClient {
    return new OkxWsClient({
      url: this.config.okxWsUrl,
      network: this.network,
      getProxy: this.getProxy,
      onCandle: (instId, timeframe, row) => {
        const candle = this.rest.parseCandleRow(row, instId, timeframe);
        if (!candle) return;
        void this.ingest(candle, 'ws').catch((error) => this.reportError(error));
      },
      onState: (state, reconnected) => {
        this.wsConnected = state === 'connected';
        this.wsState = state === 'connected' ? 'connected' : state === 'connecting' ? 'connecting' : 'disconnected';
        this.lastMessageAt = Date.now();
        for (const pair of this.pairs.values()) {
          if (!pair.initialized) continue;
          pair.status = state === 'connected' ? this.computeState(pair) : 'disconnected';
        }
        this.emit('status', this.listPairStatuses());
        if (reconnected && state === 'connected') {
          void this.handleReconnect();
        }
      },
      onError: (error) => this.reportError(error),
    });
  }

  async start(): Promise<void> {
    await this.syncClock();
    this.clockTimer = setInterval(() => {
      void this.syncClock();
    }, 5 * 60_000);
    this.clockTimer.unref?.();
    this.reconcileTimer = setInterval(() => {
      void this.reconcileAll();
    }, this.config.reconcileIntervalMs);
    this.reconcileTimer.unref?.();
  }

  private async syncClock(): Promise<void> {
    try {
      const serverNow = await this.rest.getServerTime();
      this.clockOffsetMs = serverNow - Date.now();
      this.lastClockSync = Date.now();
    } catch (error) {
      this.reportError(error);
    }
  }

  exchangeNow(): number {
    return Date.now() + this.clockOffsetMs;
  }

  private ensurePairState(ref: PairRef): PairState {
    const key = pairKey(ref.instId, ref.timeframe);
    let state = this.pairs.get(key);
    if (!state) {
      state = {
        instId: ref.instId,
        timeframe: ref.timeframe,
        candles: [],
        forming: null,
        lastReceivedAt: null,
        status: 'warming',
        initialized: false,
        initializing: null,
        lastError: null,
      };
      this.pairs.set(key, state);
    }
    return state;
  }

  async ensurePairs(pairs: PairRef[]): Promise<void> {
    const nextDesired = new Map<string, PairRef>();
    for (const pair of pairs) nextDesired.set(pairKey(pair.instId, pair.timeframe), pair);
    this.desired = nextDesired;
    const initialization: Promise<void>[] = [];
    for (const pair of nextDesired.values()) {
      const state = this.ensurePairState(pair);
      if (!state.initialized && !state.initializing) {
        state.initializing = this.initializePair(state);
      }
      if (state.initializing) initialization.push(state.initializing);
    }
    await Promise.allSettled(initialization);
    const subscriptions = [...this.desired.values()].map((pair) => ({ instId: pair.instId, timeframe: pair.timeframe }));
    await this.ws.setSubscriptions(subscriptions);
    this.emit('status', this.listPairStatuses());
  }

  private async loadInitialCandles(state: PairState): Promise<Candle[]> {
    const cached = this.store.getCandles(state.instId, state.timeframe, 300, true);
    try {
      const candles = await this.rest.getCandles(state.instId, state.timeframe, 300);
      const closed = candles.filter((candle) => candle.confirm);
      if (closed.length) this.store.upsertCandles(closed);
      return closed.length ? closed : cached;
    } catch (error) {
      if (cached.length) return cached;
      throw error;
    }
  }

  private async initializePair(state: PairState): Promise<void> {
    try {
      state.status = 'warming';
      const candles = await this.loadInitialCandles(state);
      state.candles = candles.slice(-300);
      state.initialized = state.candles.length > 0;
      state.lastReceivedAt = Date.now();
      state.lastError = null;
      state.status = this.computeState(state);
      this.emit('ready', { instId: state.instId, timeframe: state.timeframe });
      this.emit('status', this.listPairStatuses());
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      state.status = 'gap';
      this.reportError(error);
      this.emit('status', this.listPairStatuses());
    } finally {
      state.initializing = null;
    }
  }

  private computeState(state: PairState): MarketPairStatus['state'] {
    if (!state.initialized || state.candles.length < MIN_HISTORY_BARS) return 'warming';
    if (!isLatestClosedBarFresh(state.candles[state.candles.length - 1], this.exchangeNow())) return 'stale';
    if (!this.hasContinuousHistory(state.instId, state.timeframe)) return 'gap';
    return 'healthy';
  }

  private getState(instId: string, timeframe: Timeframe): PairState | null {
    return this.pairs.get(pairKey(instId, timeframe)) ?? null;
  }

  getClosedCandles(instId: string, timeframe: Timeframe, limit = 300): Candle[] {
    const state = this.getState(instId, timeframe);
    if (!state) return [];
    return state.candles.slice(-limit);
  }

  getCandlesIncludingForming(instId: string, timeframe: Timeframe, limit = 300): Candle[] {
    const state = this.getState(instId, timeframe);
    if (!state) return [];
    return [...state.candles, ...(state.forming ? [state.forming] : [])].slice(-limit);
  }

  getLatestClosed(instId: string, timeframe: Timeframe): Candle | null {
    const state = this.getState(instId, timeframe);
    return state?.candles.length ? state.candles[state.candles.length - 1] : null;
  }

  getLatestAny(instId: string, timeframe: Timeframe): Candle | null {
    const state = this.getState(instId, timeframe);
    return state?.forming ?? this.getLatestClosed(instId, timeframe);
  }

  isFresh(instId: string, timeframe: Timeframe, now = this.exchangeNow()): boolean {
    const latest = this.getLatestClosed(instId, timeframe);
    return isLatestClosedBarFresh(latest, now);
  }

  hasContinuousHistory(instId: string, timeframe: Timeframe): boolean {
    const state = this.getState(instId, timeframe);
    if (!state || state.candles.length < MIN_HISTORY_BARS) return false;
    return hasContinuousCandles(state.candles, MIN_HISTORY_BARS);
  }

  getPairStatus(instId: string, timeframe: Timeframe): MarketPairStatus {
    const state = this.getState(instId, timeframe);
    if (!state) {
      return {
        instId,
        timeframe,
        state: 'warming',
        latestClosedOpen: null,
        latestClosedAt: null,
        lastReceivedAt: null,
        bars: 0,
      };
    }
    const latest = state.candles[state.candles.length - 1] ?? null;
    return {
      instId,
      timeframe,
      state: state.status,
      latestClosedOpen: latest?.openTime ?? null,
      latestClosedAt: latest ? candleCloseTime(latest) : null,
      lastReceivedAt: state.lastReceivedAt,
      bars: state.candles.length,
    };
  }

  listPairStatuses(): MarketPairStatus[] {
    return [...this.desired.values()].map((pair) => this.getPairStatus(pair.instId, pair.timeframe));
  }

  getConnectionState(): MarketConnectionState {
    return this.wsState;
  }

  isWsConnected(): boolean {
    return this.wsConnected;
  }

  getLastMessageAt(): number | null {
    return this.lastMessageAt;
  }

  getStartedAt(): number {
    return this.startedAt;
  }

  getClockOffset(): number {
    return this.clockOffsetMs;
  }

  getRecentErrors(): { at: number; message: string }[] {
    return [...this.recentErrors];
  }

  private async ingest(candle: Candle, source: 'ws' | 'rest' | 'reconcile'): Promise<void> {
    if (this.resyncing) return;
    const state = this.getState(candle.instId, candle.timeframe);
    if (!state) return;
    state.lastReceivedAt = Date.now();
    this.lastMessageAt = Date.now();
    if (!candle.confirm) {
      state.forming = candle;
      if (source === 'ws') this.emit('tick', candle);
      return;
    }
    state.forming = null;
    const latest = state.candles[state.candles.length - 1];
    if (!latest || candle.openTime > latest.openTime) {
      const gap = latest ? candle.openTime - latest.openTime > TF_MS[candle.timeframe] : false;
      if (gap) {
        await this.handleGap(state);
        return;
      }
      state.candles.push(candle);
      if (state.candles.length > 320) state.candles = state.candles.slice(-320);
      this.store.upsertCandles([candle]);
      state.initialized = true;
      state.status = this.computeState(state);
      this.emit('closed', candle, source);
      this.emit('status', this.listPairStatuses());
    } else if (candle.openTime === latest.openTime && candle.close !== latest.close) {
      // Exchange corrections to a just-closed bar. Replace without emitting a duplicate trigger.
      state.candles[state.candles.length - 1] = candle;
      this.store.upsertCandles([candle]);
      this.emit('status', this.listPairStatuses());
    }
  }

  private async handleGap(state: PairState): Promise<void> {
    try {
      const fresh = await this.rest.getCandles(state.instId, state.timeframe, 300);
      const closed = fresh.filter((c) => c.confirm);
      if (!closed.length) throw new Error('补洞返回空数据');
      state.candles = closed;
      state.forming = null;
      state.initialized = true;
      state.lastError = null;
      state.status = this.computeState(state);
      this.store.upsertCandles(closed);
      this.emit('resync', [{ instId: state.instId, timeframe: state.timeframe }]);
      this.emit('status', this.listPairStatuses());
    } catch (error) {
      state.status = 'gap';
      state.lastError = error instanceof Error ? error.message : String(error);
      this.reportError(error);
      this.emit('status', this.listPairStatuses());
    }
  }

  private async handleReconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.resyncing = true;
    try {
      const affected: PairRef[] = [];
      for (const pair of this.desired.values()) {
        const state = this.ensurePairState(pair);
        try {
          const fresh = await this.rest.getCandles(pair.instId, pair.timeframe, 300);
          const closed = fresh.filter((c) => c.confirm);
          if (!closed.length) throw new Error('重连补数据为空');
          state.candles = closed.slice(-300);
          state.forming = null;
          state.initialized = true;
          state.lastReceivedAt = Date.now();
          state.lastError = null;
          state.status = this.computeState(state);
          this.store.upsertCandles(closed);
          affected.push(pair);
        } catch (error) {
          state.status = 'gap';
          state.lastError = error instanceof Error ? error.message : String(error);
          this.reportError(error);
        }
      }
      this.resyncing = false;
      if (affected.length) this.emit('resync', affected);
      this.emit('status', this.listPairStatuses());
    } finally {
      this.reconnecting = false;
      this.resyncing = false;
    }
  }

  private async reconcileAll(): Promise<void> {
    if (this.stopped || this.reconcileRunning) return;
    this.reconcileRunning = true;
    try {
      for (const pair of this.desired.values()) {
        const state = this.ensurePairState(pair);
        if (!state.initialized) continue;
        try {
          const recent = await this.rest.getCandles(pair.instId, pair.timeframe, 3);
          const closed = recent.filter((c) => c.confirm);
          if (!closed.length) continue;
          const latest = state.candles[state.candles.length - 1];
          const newest = closed[closed.length - 1];
          if (!latest) {
            await this.ingest(newest, 'reconcile');
            continue;
          }
          if (newest.openTime - latest.openTime > TF_MS[pair.timeframe]) {
            await this.handleGap(state);
            continue;
          }
          for (const candle of closed) {
            if (candle.openTime > latest.openTime) {
              await this.ingest(candle, 'reconcile');
            }
          }
          state.status = this.computeState(state);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (state.status === 'healthy' && !isLatestClosedBarFresh(state.candles.at(-1), this.exchangeNow())) {
            state.status = 'stale';
            state.lastError = message;
          }
          this.reportError(error);
        }
      }
      this.emit('status', this.listPairStatuses());
    } finally {
      this.reconcileRunning = false;
    }
  }

  async restartForProxyChange(): Promise<void> {
    this.ws.close();
    this.ws = this.createWsClient();
    this.network.updateProxy(this.getProxy());
    const subscriptions = [...this.desired.values()].map((pair) => ({ instId: pair.instId, timeframe: pair.timeframe }));
    await this.handleReconnect();
    await this.ws.setSubscriptions(subscriptions);
  }

  async testConnection(proxyUrl = this.getProxy()): Promise<{ ok: boolean; latencyMs: number; serverNow: number }> {
    const priorProxy = this.network.getProxyUrl();
    this.network.updateProxy(proxyUrl);
    const before = Date.now();
    try {
      const serverNow = await this.rest.getServerTime();
      return { ok: true, latencyMs: Date.now() - before, serverNow };
    } finally {
      this.network.updateProxy(priorProxy);
    }
  }

  async getInstruments(query: string): Promise<OkxInstrument[]> {
    const { spots, swaps } = await this.rest.getInstruments();
    const all = [...swaps, ...spots];
    const q = query.trim().toUpperCase();
    const filtered = q
      ? all.filter((item) => item.instId.includes(q) || item.baseCcy.includes(q))
      : all;
    return filtered.slice(0, 80);
  }

  async fetchHistory(instId: string, timeframe: Timeframe, from: number, now = this.exchangeNow()): Promise<Candle[]> {
    return this.rest.fetchHistoryWindow(instId, timeframe, from, now);
  }

  private reportError(error: unknown): void {
    const raw = error instanceof Error ? error.message : String(error);
    const message = this.redact(raw);
    this.recentErrors.push({ at: Date.now(), message });
    if (this.recentErrors.length > 30) this.recentErrors.shift();
    if (process.env.NODE_ENV !== 'test') {
      console.error('[market]', message);
    }
    this.emit('marketError', new Error(message));
  }

  private redact(message: string): string {
    const proxy = this.getProxy();
    if (proxy) {
      try {
        const parsed = new URL(proxy);
        if (parsed.username || parsed.password) {
          return message.split(proxy).join(parsed.protocol + '//' + parsed.host + '/***');
        }
      } catch {
        // ignore
      }
    }
    return message;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.clockTimer) clearInterval(this.clockTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.clockTimer = null;
    this.reconcileTimer = null;
    this.ws.close();
    await sleep(10);
    this.network.dispose();
  }
}

export function subscribePairsFromRules(rules: { symbols: string[]; expression: import('../../shared/types').ExpressionNode }[]): PairRef[] {
  const result = new Map<string, PairRef>();
  for (const rule of rules) {
    const timeframes = new Set<Timeframe>();
    const walk = (node: import('../../shared/types').ExpressionNode) => {
      if (node.kind === 'condition') timeframes.add(node.timeframe);
      else node.children.forEach(walk);
    };
    walk(rule.expression);
    for (const symbol of rule.symbols) {
      for (const timeframe of timeframes) {
        result.set(pairKey(symbol, timeframe), { instId: symbol, timeframe });
      }
    }
  }
  return [...result.values()];
}

export function isExpectedFresh(instId: string, timeframe: Timeframe, candles: Candle[], now: number): boolean {
  const latest = candles[candles.length - 1];
  if (!latest) return false;
  return latest.openTime >= expectedLatestClosedOpen(now, timeframe);
}
