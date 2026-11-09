import { describe, expect, it } from 'vitest';
import {
  bollingerBands,
  compareValues,
  ema,
  kdj,
  macd,
  rsi,
  sma,
  volumeRatio,
} from '../../src/server/indicators';
import { makeCandles } from '../helpers/fake-market';

const closes = [1, 2, 3, 4, 5];
const candles = closes.map((close, index) => ({
  open: close,
  high: close + 0.2,
  low: close - 0.2,
  close,
  volume: 10 + index * 10,
}));

describe('SMA / EMA', () => {
  it('computes SMA with null warmup', () => {
    expect(sma(closes, 3)).toEqual([null, null, 2, 3, 4]);
  });

  it('computes EMA seeded by SMA', () => {
    expect(ema(closes, 3)).toEqual([null, null, 2, 3, 4]);
  });

  it('returns all null when not enough bars', () => {
    expect(sma([1, 2], 3)).toEqual([null, null]);
    expect(ema([1, 2], 3)).toEqual([null, null]);
  });
});

describe('Bollinger Bands', () => {
  it('uses population standard deviation and computes derived series', () => {
    const bb = bollingerBands(candles, { length: 3, mult: 2, slopeWindow: 1 });
    expect(bb.middle[2]).toBeCloseTo(2, 8);
    expect(bb.upper[2]).toBeCloseTo(2 + 2 * Math.sqrt(2 / 3), 8);
    expect(bb.lower[2]).toBeCloseTo(2 - 2 * Math.sqrt(2 / 3), 8);
    expect(bb.bandwidth[2]).toBeCloseTo(((4 * Math.sqrt(2 / 3)) / 2) * 100, 8);
    expect(bb.percentB[2]).toBeCloseTo((3 - (2 - 2 * Math.sqrt(2 / 3))) / (4 * Math.sqrt(2 / 3)), 8);
    expect(bb.midSlope[2]).toBeNull();
    expect(bb.midSlope[3]).toBeCloseTo(50, 8);
    expect(bb.midSlope[4]).toBeCloseTo((4 - 3) / 3 / 1 * 100, 8);
  });

  it('returns null %B when band width is zero', () => {
    const flat = Array.from({ length: 5 }, () => ({ open: 10, high: 10, low: 10, close: 10, volume: 1 }));
    const bb = bollingerBands(flat, { length: 3, mult: 2 });
    expect(bb.upper[2]).toBe(10);
    expect(bb.lower[2]).toBe(10);
    expect(bb.percentB[2]).toBeNull();
  });
});

describe('KDJ', () => {
  it('matches the Chinese 9,3,3 convention with seed 50', () => {
    const data = Array.from({ length: 9 }, (_, index) => ({
      open: 9.5 + index,
      high: 10 + index,
      low: 9 + index,
      close: 9.5 + index,
      volume: 100,
    }));
    const result = kdj(data, { length: 9, kSmooth: 3, dSmooth: 3 });
    const rsv = ((17.5 - 9) / (18 - 9)) * 100;
    const k = (2 * 50 + rsv) / 3;
    const d = (2 * 50 + k) / 3;
    expect(result.k[8]).toBeCloseTo(k, 8);
    expect(result.d[8]).toBeCloseTo(d, 8);
    expect(result.j[8]).toBeCloseTo(3 * k - 2 * d, 8);
    expect(result.k[7]).toBeNull();
  });

  it('uses RSV=50 for a flat window', () => {
    const data = Array.from({ length: 12 }, () => ({ open: 10, high: 10, low: 10, close: 10, volume: 1 }));
    const result = kdj(data, { length: 9 });
    expect(result.k[11]).toBeCloseTo(50, 8);
    expect(result.d[11]).toBeCloseTo(50, 8);
    expect(result.j[11]).toBeCloseTo(50, 8);
  });
});

describe('RSI', () => {
  const rising = makeCandles({ instId: 'X', timeframe: '5m', count: 40, endCloseTime: 40 * 300_000 }).map((c) => ({
    ...c,
    close: 100 + c.openTime / 300_000,
    high: 200 + c.openTime / 300_000,
    low: 50,
  }));
  const falling = rising.map((c) => ({ ...c, close: 1000 - c.openTime / 300_000, high: 2000, low: 50 }));
  const flat = rising.map((c) => ({ ...c, close: 100, high: 101, low: 99 }));

  it('returns 100 for all gains', () => {
    const values = rsi(rising, { length: 14 });
    expect(values[13]).toBeNull();
    expect(values[14]).toBeCloseTo(100, 8);
    expect(values[39]).toBeCloseTo(100, 8);
  });

  it('returns 0 for all losses', () => {
    const values = rsi(falling, { length: 14 });
    expect(values[20]).toBeCloseTo(0, 8);
  });

  it('returns 50 for a flat series', () => {
    const values = rsi(flat, { length: 14 });
    expect(values[20]).toBeCloseTo(50, 8);
  });
});

describe('MACD', () => {
  it('is zero for a constant price', () => {
    const data = Array.from({ length: 60 }, () => ({ open: 100, high: 101, low: 99, close: 100, volume: 10 }));
    const result = macd(data, { fast: 12, slow: 26, signal: 9 });
    expect(result.dif[25]).toBeCloseTo(0, 8);
    expect(result.dea[33]).toBeCloseTo(0, 8);
    expect(result.hist[40]).toBeCloseTo(0, 8);
    expect(result.hist[32]).toBeNull();
  });

  it('histogram is DIF − DEA, not doubled', () => {
    const data = Array.from({ length: 80 }, (_, index) => ({
      open: 100 + index,
      high: 101 + index,
      low: 99 + index,
      close: 100 + index,
      volume: 10,
    }));
    const result = macd(data, {});
    expect(result.hist[70]).toBeCloseTo((result.dif[70] as number) - (result.dea[70] as number), 8);
  });
});

describe('volume', () => {
  it('uses quote volume and computes ratio', () => {
    const vols = [10, 20, 30, 40, 50];
    const data = vols.map((volume) => ({ open: 1, high: 2, low: 0.5, close: 1, volume }));
    const ratio = volumeRatio(data, { maLength: 3 });
    expect(ratio[1]).toBeNull();
    expect(ratio[2]).toBeCloseTo(1.5, 8);
    expect(ratio[3]).toBeCloseTo(40 / 30, 8);
    expect(ratio[4]).toBeCloseTo(50 / 40, 8);
  });
});

describe('comparators', () => {
  it('handles all four operators', () => {
    expect(compareValues(2, 'gt', 1)).toBe(true);
    expect(compareValues(2, 'gte', 2)).toBe(true);
    expect(compareValues(1, 'lt', 2)).toBe(true);
    expect(compareValues(2, 'lte', 2)).toBe(true);
    expect(compareValues(2, 'gt', 2)).toBe(false);
  });
});
