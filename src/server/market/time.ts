import {
  type Candle,
  type MarketPairStatus,
  type Timeframe,
  TF_MS,
} from '../../shared/types';

export const UTC8_OFFSET_MS = 8 * 3_600_000;
export const CLOSE_GRACE_MS = 2_000;

export function expectedLatestClosedOpen(now: number, timeframe: Timeframe): number {
  const tf = TF_MS[timeframe];
  const t = now - CLOSE_GRACE_MS;
  const offset = timeframe === '1D' ? UTC8_OFFSET_MS : 0;
  return Math.floor((t + offset) / tf) * tf - tf - offset;
}

export function expectedCurrentBarOpen(now: number, timeframe: Timeframe): number {
  const tf = TF_MS[timeframe];
  const offset = timeframe === '1D' ? UTC8_OFFSET_MS : 0;
  return Math.floor((now + offset) / tf) * tf - offset;
}

export function candleCloseTime(candle: Pick<Candle, 'openTime' | 'timeframe'>): number {
  return candle.openTime + TF_MS[candle.timeframe];
}

export function isLatestClosedBarFresh(
  candle: Pick<Candle, 'openTime' | 'timeframe'> | null | undefined,
  now: number,
): boolean {
  if (!candle) return false;
  return candle.openTime >= expectedLatestClosedOpen(now, candle.timeframe);
}

export function hasContinuousCandles(candles: Candle[], minBars: number): boolean {
  if (candles.length < minBars) return false;
  const recent = candles.slice(-minBars);
  const tf = TF_MS[recent[0].timeframe];
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].openTime - recent[i - 1].openTime !== tf) return false;
  }
  return recent.every((c) => c.confirm);
}

export function pairStatusFromCandles(
  instId: string,
  timeframe: Timeframe,
  candles: Candle[],
  now: number,
  state?: MarketPairStatus['state'],
): MarketPairStatus {
  const latest = candles.length ? candles[candles.length - 1] : null;
  const computedState: MarketPairStatus['state'] = !latest
    ? 'warming'
    : isLatestClosedBarFresh(latest, now)
      ? 'healthy'
      : 'stale';
  return {
    instId,
    timeframe,
    state: state ?? computedState,
    latestClosedOpen: latest?.openTime ?? null,
    latestClosedAt: latest ? latest.openTime + TF_MS[timeframe] : null,
    lastReceivedAt: null,
    bars: candles.length,
  };
}

export function isOlderThanOneBar(latest: Candle | null, now: number, timeframe: Timeframe): boolean {
  if (!latest) return true;
  return now - (latest.openTime + TF_MS[timeframe]) > TF_MS[timeframe] + CLOSE_GRACE_MS;
}
