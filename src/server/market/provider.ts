import type { MarketPairStatus } from '../../shared/types';
import type { Candle } from '../../shared/types';

export interface PairRef {
  instId: string;
  timeframe: import('../../shared/types').Timeframe;
}

export type MarketEventName = 'closed' | 'tick' | 'ready' | 'resync' | 'status' | 'marketError';
export type MarketConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected';

export interface MarketDataProvider {
  on(event: MarketEventName, listener: (...args: any[]) => void): unknown;
  off(event: MarketEventName, listener: (...args: any[]) => void): unknown;
  exchangeNow(): number;
  getClosedCandles(instId: string, timeframe: import('../../shared/types').Timeframe, limit?: number): Candle[];
  getCandlesIncludingForming(instId: string, timeframe: import('../../shared/types').Timeframe, limit?: number): Candle[];
  getLatestClosed(instId: string, timeframe: import('../../shared/types').Timeframe): Candle | null;
  isFresh(instId: string, timeframe: import('../../shared/types').Timeframe, now?: number): boolean;
  hasContinuousHistory(instId: string, timeframe: import('../../shared/types').Timeframe): boolean;
  getPairStatus(instId: string, timeframe: import('../../shared/types').Timeframe): MarketPairStatus;
  listPairStatuses(): MarketPairStatus[];
  ensurePairs(pairs: PairRef[]): Promise<void>;
  getConnectionState(): MarketConnectionState;
  getLastMessageAt(): number | null;
  stop(): Promise<void>;
}

export function pairKey(instId: string, timeframe: string): string {
  return `${instId}|${timeframe}`;
}


export interface InstrumentInfo {
  instId: string;
  instType: string;
  state: string;
  baseCcy?: string;
  quoteCcy?: string;
  settleCcy?: string;
  tickSz?: string;
  lotSz?: string;
}

export interface AppMarket extends MarketDataProvider {
  start?(): Promise<void>;
  addChartPair?(pair: PairRef): Promise<void>;
  releaseChartPair?(pair: PairRef): Promise<void>;
  getInstruments(query: string): Promise<InstrumentInfo[]>;
  fetchHistory(instId: string, timeframe: import('../../shared/types').Timeframe, from: number, now?: number): Promise<Candle[]>;
  testConnection(proxyUrl?: string): Promise<{ ok: boolean; latencyMs: number; serverNow: number }>;
  getRecentErrors(): { at: number; message: string }[];
  getClockOffset(): number;
  isWsConnected(): boolean;
  getLastMessageAt(): number | null;
  getStartedAt(): number;
  restartForProxyChange?(): Promise<void>;
}
