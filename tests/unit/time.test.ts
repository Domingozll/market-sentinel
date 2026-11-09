import { describe, expect, it } from 'vitest';
import {
  expectedCurrentBarOpen,
  expectedLatestClosedOpen,
  hasContinuousCandles,
  isLatestClosedBarFresh,
} from '../../src/server/market/time';
import { TF_MS } from '../../src/shared/types';
import { makeCandles } from '../helpers/fake-market';

const at = (iso: string) => Date.parse(iso);

describe('exchange boundaries', () => {
  it('computes latest closed 15m bar open on UTC+8 aligned boundaries', () => {
    const now = at('2026-11-09T10:20:10+08:00');
    const expected = at('2026-11-09T10:00:00+08:00');
    expect(expectedLatestClosedOpen(now, '15m')).toBe(expected);
    expect(expectedCurrentBarOpen(now, '15m')).toBe(at('2026-11-09T10:15:00+08:00'));
  });

  it('uses UTC+8 day boundary for 1D', () => {
    const now = at('2026-11-09T10:20:10+08:00');
    expect(expectedLatestClosedOpen(now, '1D')).toBe(at('2026-11-08T00:00:00+08:00'));
    expect(expectedCurrentBarOpen(now, '1D')).toBe(at('2026-11-09T00:00:00+08:00'));
  });

  it('allows a small grace window after close', () => {
    const lastClosedOpen = at('2026-11-09T10:15:00+08:00');
    const candle = {
      openTime: lastClosedOpen,
      timeframe: '5m' as const,
      confirm: true,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
      vol: 1,
      volCcy: 1,
      volCcyQuote: 1,
      instId: 'BTC-USDT-SWAP',
    };
    expect(isLatestClosedBarFresh(candle, at('2026-11-09T10:20:01+08:00'))).toBe(true);
    expect(isLatestClosedBarFresh(candle, at('2026-11-09T10:20:05+08:00'))).toBe(true);
    expect(isLatestClosedBarFresh(candle, at('2026-11-09T10:20:30+08:00'))).toBe(true);
    expect(isLatestClosedBarFresh(candle, at('2026-11-09T10:25:30+08:00'))).toBe(false);
  });
});

describe('continuity', () => {
  it('accepts contiguous closed candles and rejects gaps', () => {
    const end = 300 * 300_000;
    const candles = makeCandles({ instId: 'X', timeframe: '5m', count: 220, endCloseTime: end });
    expect(hasContinuousCandles(candles, 200)).toBe(true);
    const gapped = candles.filter((_, i) => i !== 50);
    expect(hasContinuousCandles(gapped, 200)).toBe(false);
    expect(hasContinuousCandles(candles.slice(0, 100), 200)).toBe(false);
    expect(TF_MS['5m']).toBe(300_000);
  });
});
