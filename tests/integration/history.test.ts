import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../src/server/store';
import { loadLocalFirstHistory, HistoryError } from '../../src/server/history';
import { FakeMarket, makeCandles } from '../helpers/fake-market';
import type { Candle } from '../../src/shared/types';

const symbol = 'BTC-USDT-SWAP';
const timeframe = '5m' as const;
const tfMs = 300_000;
const endClose = Date.parse('2026-11-16T16:00:00+08:00');
const now = endClose + 5_000;

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function makeStore(): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-history-'));
  dirs.push(dir);
  return new Store(path.join(dir, 'sentinel.db'));
}

function history(count = 500): Candle[] {
  return makeCandles({ instId: symbol, timeframe, count, endCloseTime: endClose });
}

function marketWith(candles: Candle[]): FakeMarket {
  const market = new FakeMarket(now);
  market.setHistory(symbol, timeframe, candles);
  return market;
}

describe('local-first historical data', () => {
  it('reuses a complete local range without touching the network', async () => {
    const store = makeStore();
    const candles = history(300);
    store.upsertCandles(candles);
    const market = marketWith(candles);
    const fetchSpy = vi.spyOn(market, 'fetchHistory');
    const from = candles[0].openTime;
    const loaded = await loadLocalFirstHistory({ store, market, instId: symbol, timeframe, from, to: now });
    expect(loaded.candles).toHaveLength(candles.length);
    expect(loaded.source).toBe('local');
    expect(loaded.fetchedBars).toBe(0);
    expect(loaded.coverage).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    store.close();
  });

  it('supplements only a missing prefix and persists it locally', async () => {
    const store = makeStore();
    const candles = history(100);
    const local = candles.slice(-60);
    store.upsertCandles(local);
    const market = marketWith(candles);
    const fetchSpy = vi.spyOn(market, 'fetchHistory');
    const loaded = await loadLocalFirstHistory({
      store,
      market,
      instId: symbol,
      timeframe,
      from: candles[0].openTime,
      to: now,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(loaded.candles).toHaveLength(100);
    expect(loaded.localBars).toBe(60);
    expect(loaded.fetchedBars).toBe(40);
    expect(loaded.source).toBe('local+remote');
    expect(store.getCandleRange(symbol, timeframe, candles[0].openTime, candles[99].openTime)).toHaveLength(100);
    store.close();
  });

  it('rejects an incomplete strict range after attempting batch fill', async () => {
    const store = makeStore();
    const full = history(100);
    const local = full.slice(20);
    store.upsertCandles(local);
    const market = marketWith(local);
    await expect(loadLocalFirstHistory({
      store,
      market,
      instId: symbol,
      timeframe,
      from: full[0].openTime,
      to: full[99].openTime + tfMs,
      strictRange: true,
    })).rejects.toBeInstanceOf(HistoryError);
    store.close();
  });

  it('supplements a missing tail and then reuses the completed local range', async () => {
    const store = makeStore();
    const candles = history(100);
    store.upsertCandles(candles.slice(0, 70));
    const market = marketWith(candles);
    const fetchSpy = vi.spyOn(market, 'fetchHistory');
    const loaded = await loadLocalFirstHistory({
      store,
      market,
      instId: symbol,
      timeframe,
      from: candles[0].openTime,
      to: now,
    });
    expect(loaded.candles).toHaveLength(100);
    expect(loaded.fetchedBars).toBe(30);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const second = await loadLocalFirstHistory({
      store,
      market,
      instId: symbol,
      timeframe,
      from: candles[0].openTime,
      to: now,
    });
    expect(second.source).toBe('local');
    expect(second.fetchedBars).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    store.close();
  });

  it('fills an internal gap from remote and keeps a single ordered series', async () => {
    const store = makeStore();
    const candles = history(100);
    store.upsertCandles(candles.filter((_, index) => index < 40 || index >= 45));
    const market = marketWith(candles);
    const loaded = await loadLocalFirstHistory({
      store,
      market,
      instId: symbol,
      timeframe,
      from: candles[0].openTime,
      to: now,
    });
    expect(loaded.candles).toHaveLength(100);
    expect(loaded.fetchedBars).toBe(5);
    expect(loaded.gaps).toBe(0);
    expect(loaded.candles.map((candle) => candle.openTime)).toEqual(
      [...loaded.candles.map((candle) => candle.openTime)].sort((a, b) => a - b),
    );
    store.close();
  });

  it('rejects an internal gap instead of silently evaluating across it', async () => {
    const store = makeStore();
    const candles = history(100);
    const withHole = candles.filter((_, index) => index < 40 || index >= 45);
    store.upsertCandles(withHole);
    const market = marketWith([]);
    await expect(loadLocalFirstHistory({
      store,
      market,
      instId: symbol,
      timeframe,
      from: candles[0].openTime,
      to: now,
    })).rejects.toBeInstanceOf(HistoryError);
    store.close();
  });

  it('accepts an unavailable leading range with explicit coverage metadata', async () => {
    const store = makeStore();
    const candles = history(80);
    store.upsertCandles(candles.slice(-50));
    const market = marketWith([]);
    const loaded = await loadLocalFirstHistory({
      store,
      market,
      instId: symbol,
      timeframe,
      from: candles[0].openTime,
      to: now,
    });
    expect(loaded.candles).toHaveLength(50);
    expect(loaded.coverage).toBeCloseTo(0.625, 3);
    expect(loaded.gaps).toBe(30);
    expect(loaded.source).toBe('local');
    store.close();
  });
});
