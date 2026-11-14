import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store } from '../src/server/store';
import { computeVolumeProfile } from '../src/web/lib/chart/volumeProfile';
import type { Candle } from '../src/shared/types';

const dir =
  process.env.CHART_PERF_DIR ??
  (fs.existsSync('/Volumes/Leo') ? '/Volumes/Leo/market-sentinel-chart-perf' : path.join(os.tmpdir(), 'market-sentinel-chart-perf'));
const count = Number(process.env.CHART_PERF_BARS ?? 20000);
const base = Date.parse('2026-01-01T00:00:00+08:00');
const tf = 300_000;

fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const store = new Store(dir);
try {
  const candles: Candle[] = Array.from({ length: count }, (_, index) => {
    const close = 100 + Math.sin(index / 40) * 20 + index * 0.004;
    const open = close - 0.1;
    return {
      instId: 'BTC-USDT-SWAP',
      timeframe: '5m',
      openTime: base + index * tf,
      open,
      high: close + 0.4,
      low: open - 0.4,
      close,
      volume: 1000 + (index % 100),
      vol: 10,
      volCcy: 10,
      volCcyQuote: 1000 + (index % 100),
      confirm: true,
    };
  });

  const insertStart = performance.now();
  store.upsertCandles(candles);
  const insertMs = performance.now() - insertStart;

  const queryStart = performance.now();
  const page = store.getCandlesBefore('BTC-USDT-SWAP', '5m', base + count * tf, 1000);
  const queryMs = performance.now() - queryStart;
  if (page.length !== 1000) throw new Error(`expected 1000 candles, got ${page.length}`);

  const profileStart = performance.now();
  const profile = computeVolumeProfile(
    page.map((candle) => ({ low: candle.low, high: candle.high, turnover: candle.volCcyQuote })),
    80,
  );
  const profileMs = performance.now() - profileStart;
  if (!profile.poc || profile.totalVolume <= 0) throw new Error('profile was empty');

  const dbBytes = ['market-sentinel.db', 'market-sentinel.db-wal', 'market-sentinel.db-shm']
    .map((name) => {
      try { return fs.statSync(path.join(dir, name)).size; } catch { return 0; }
    })
    .reduce((sum, size) => sum + size, 0);
  console.log(JSON.stringify({
    externalDir: dir,
    bars: count,
    dbBytes,
    insertMs: Math.round(insertMs),
    query1000Ms: Math.round(queryMs * 10) / 10,
    profile5000BarsMs: Math.round(profileMs * 10) / 10,
    profilePoc: profile.poc,
  }, null, 2));
} finally {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
