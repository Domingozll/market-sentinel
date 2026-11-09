import type { Candle, Timeframe } from '../../shared/types';
import { TF_MS, TF_TO_OKX_BAR } from '../../shared/types';
import { NetworkContext, sleep } from '../network';

const USER_AGENT = 'MarketSentinel/1.0 (local OKX public data monitor)';

export class OkxRestError extends Error {
  code: string;
  httpStatus: number | null;
  constructor(message: string, code = 'okx_error', httpStatus: number | null = null) {
    super(message);
    this.name = 'OkxRestError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface OkxRestOptions {
  baseUrl: string;
  network: NetworkContext;
  getProxy: () => string;
  minIntervalMs?: number;
  timeoutMs?: number;
  retryBaseMs?: number;
}

export interface OkxInstrument {
  instId: string;
  instType: string;
  state: string;
  baseCcy: string;
  quoteCcy: string;
  settleCcy: string;
  ctVal: string;
  ctValCcy: string;
  tickSz: string;
  lotSz: string;
}

interface Envelope {
  code?: string;
  msg?: string;
  data?: unknown;
}

export class OkxRestClient {
  private baseUrl: string;
  private network: NetworkContext;
  private getProxy: () => string;
  private minIntervalMs: number;
  private timeoutMs: number;
  private retryBaseMs: number;
  private lastRequestAt = 0;
  private gate: Promise<void> = Promise.resolve();
  private instrumentCache: { at: number; spots: OkxInstrument[]; swaps: OkxInstrument[] } | null = null;

  constructor(options: OkxRestOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.network = options.network;
    this.getProxy = options.getProxy;
    this.minIntervalMs = options.minIntervalMs ?? 130;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.retryBaseMs = options.retryBaseMs ?? 300;
  }

  private async waitForSlot(): Promise<void> {
    const previous = this.gate;
    let release!: () => void;
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const delay = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (delay > 0) await sleep(delay);
    this.lastRequestAt = Date.now();
    release();
  }

  private async fetchJson(path: string, params: Record<string, string | number | undefined>): Promise<unknown[]> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    this.network.updateProxy(this.getProxy());
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.waitForSlot();
      let response: Response;
      try {
        response = await this.network.fetch(url.toString(), {
          method: 'GET',
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < 3) {
          await sleep(this.retryBaseMs * 2 ** attempt);
          continue;
        }
        throw new OkxRestError(`OKX 请求失败：${lastError.message}`, 'network');
      }
      const text = await response.text();
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 10_000)
          : this.retryBaseMs * 2 ** attempt;
        lastError = new OkxRestError(
          `OKX 暂时不可用（HTTP ${response.status}）`,
          'http_retryable',
          response.status,
        );
        if (attempt < 3) {
          await sleep(wait);
          continue;
        }
        throw lastError;
      }
      if (!response.ok) {
        let message = `OKX HTTP ${response.status}`;
        try {
          const envelope = JSON.parse(text) as Envelope;
          if (envelope.msg) message += `：${envelope.msg}`;
        } catch {
          // ignore response body parsing
        }
        throw new OkxRestError(message, 'http_error', response.status);
      }
      let envelope: Envelope;
      try {
        envelope = JSON.parse(text) as Envelope;
      } catch {
        throw new OkxRestError('OKX 返回了非 JSON 响应', 'invalid_json', response.status);
      }
      if (envelope.code !== undefined && envelope.code !== '0') {
        throw new OkxRestError(`OKX 错误 ${envelope.code}：${envelope.msg || '未知错误'}`, envelope.code, response.status);
      }
      if (!Array.isArray(envelope.data)) {
        throw new OkxRestError('OKX 返回数据格式异常', 'invalid_data', response.status);
      }
      return envelope.data;
    }
    throw lastError ?? new OkxRestError('OKX 请求失败', 'unknown');
  }

  async getServerTime(): Promise<number> {
    const data = await this.fetchJson('/api/v5/public/time', {});
    const row = data[0] as { ts?: string } | undefined;
    const ts = Number(row?.ts);
    if (!Number.isFinite(ts)) throw new OkxRestError('OKX 服务器时间格式异常', 'invalid_time');
    return ts;
  }

  parseCandleRow(row: unknown, instId: string, timeframe: Timeframe): Candle | null {
    if (!Array.isArray(row) || row.length < 9) return null;
    const values = row.map((value) => String(value));
    const [ts, open, high, low, close, vol, volCcy, volCcyQuote, confirm] = values;
    const numeric = [ts, open, high, low, close, vol, volCcy, volCcyQuote].map(Number);
    if (numeric.some((value) => !Number.isFinite(value))) return null;
    return {
      instId,
      timeframe,
      openTime: numeric[0],
      open: numeric[1],
      high: numeric[2],
      low: numeric[3],
      close: numeric[4],
      volume: numeric[7],
      vol: numeric[5],
      volCcy: numeric[6],
      volCcyQuote: numeric[7],
      confirm: confirm === '1',
    };
  }

  private parseCandles(rows: unknown[], instId: string, timeframe: Timeframe, onlyClosed: boolean): Candle[] {
    const candles = rows
      .map((row) => this.parseCandleRow(row, instId, timeframe))
      .filter((candle): candle is Candle => Boolean(candle) && (!onlyClosed || candle!.confirm));
    const byTime = new Map<number, Candle>();
    for (const candle of candles) byTime.set(candle.openTime, candle);
    return [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
  }

  async getCandles(instId: string, timeframe: Timeframe, limit = 300, after?: number): Promise<Candle[]> {
    const rows = await this.fetchJson('/api/v5/market/candles', {
      instId,
      bar: TF_TO_OKX_BAR[timeframe],
      limit: Math.min(300, Math.max(1, limit)),
      after,
    });
    return this.parseCandles(rows, instId, timeframe, false);
  }

  async getHistoryCandles(instId: string, timeframe: Timeframe, after?: number, limit = 100): Promise<Candle[]> {
    const rows = await this.fetchJson('/api/v5/market/history-candles', {
      instId,
      bar: TF_TO_OKX_BAR[timeframe],
      limit: Math.min(100, Math.max(1, limit)),
      after,
    });
    return this.parseCandles(rows, instId, timeframe, false);
  }

  async getInstruments(force = false): Promise<{ spots: OkxInstrument[]; swaps: OkxInstrument[] }> {
    if (!force && this.instrumentCache && Date.now() - this.instrumentCache.at < 300_000) {
      return this.instrumentCache;
    }
    const [spotRows, swapRows] = await Promise.all([
      this.fetchJson('/api/v5/public/instruments', { instType: 'SPOT' }),
      this.fetchJson('/api/v5/public/instruments', { instType: 'SWAP' }),
    ]);
    const map = (rows: unknown[]): OkxInstrument[] =>
      rows
        .map((row) => row as Record<string, string>)
        .filter((row) => row && row.instId && row.state !== 'suspend')
        .map((row) => ({
          instId: row.instId,
          instType: row.instType,
          state: row.state,
          baseCcy: row.baseCcy ?? '',
          quoteCcy: row.quoteCcy ?? '',
          settleCcy: row.settleCcy ?? '',
          ctVal: row.ctVal ?? '',
          ctValCcy: row.ctValCcy ?? '',
          tickSz: row.tickSz ?? '',
          lotSz: row.lotSz ?? '',
        }))
        .filter((row) => row.state === 'live')
        .sort((a, b) => a.instId.localeCompare(b.instId));
    const result = { at: Date.now(), spots: map(spotRows), swaps: map(swapRows) };
    this.instrumentCache = result;
    return result;
  }

  /**
   * Download a historical window, paging backwards from the newest history.
   * Returns confirmed candles sorted oldest-first, limited to [from, now].
   */
  async fetchHistoryWindow(
    instId: string,
    timeframe: Timeframe,
    from: number,
    now = Date.now(),
    maxPages = 140,
  ): Promise<Candle[]> {
    const tf = TF_MS[timeframe];
    let cursor: number | undefined;
    let pages = 0;
    let oldest = Number.POSITIVE_INFINITY;
    const all = new Map<number, Candle>();
    while (pages < maxPages) {
      pages++;
      const page = await this.getHistoryCandles(instId, timeframe, cursor, 100);
      if (page.length === 0) break;
      for (const candle of page) {
        if (candle.confirm && candle.openTime >= from && candle.openTime + tf <= now + 1) {
          all.set(candle.openTime, candle);
        }
      }
      const pageOldest = page[0].openTime;
      oldest = Math.min(oldest, pageOldest);
      if (oldest <= from) break;
      if (cursor === pageOldest) break;
      cursor = pageOldest;
    }
    return [...all.values()].sort((a, b) => a.openTime - b.openTime);
  }
}
