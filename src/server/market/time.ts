import {
  type Candle,
  type MarketPairStatus,
  type Timeframe,
  TF_MS,
  UTC8_ALIGNED_TIMEFRAMES,
} from '../../shared/types';

export const UTC8_OFFSET_MS = 8 * 3_600_000;
export const CLOSE_GRACE_MS = 2_000;
const WEEK_ANCHOR_UTC = Date.UTC(1970, 0, 5); // Monday 00:00 UTC

function alignmentOffset(timeframe: Timeframe): number {
  return UTC8_ALIGNED_TIMEFRAMES.has(timeframe) ? UTC8_OFFSET_MS : 0;
}

function isMonthly(timeframe: Timeframe): boolean {
  return timeframe === '1M' || timeframe === '3M' || timeframe === '1Mutc' || timeframe === '3Mutc';
}

function monthSpan(timeframe: Timeframe): number {
  return timeframe === '3M' || timeframe === '3Mutc' ? 3 : 1;
}

function monthStart(now: number, timeframe: Timeframe): number {
  const offset = alignmentOffset(timeframe);
  const date = new Date(now + offset);
  const month = date.getUTCMonth();
  const span = monthSpan(timeframe);
  const alignedMonth = month - (month % span);
  return Date.UTC(date.getUTCFullYear(), alignedMonth, 1) - offset;
}

function previousMonthStart(now: number, timeframe: Timeframe): number {
  const offset = alignmentOffset(timeframe);
  const current = new Date(monthStart(now, timeframe) + offset);
  const span = monthSpan(timeframe);
  return Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - span, 1) - offset;
}

function weekStart(now: number, timeframe: Timeframe): number {
  const offset = alignmentOffset(timeframe);
  return Math.floor((now - WEEK_ANCHOR_UTC + offset) / TF_MS[timeframe]) * TF_MS[timeframe] + WEEK_ANCHOR_UTC - offset;
}

export function expectedCurrentBarOpen(now: number, timeframe: Timeframe): number {
  if (isMonthly(timeframe)) return monthStart(now, timeframe);
  if (timeframe === '1W' || timeframe === '1Wutc') return weekStart(now, timeframe);
  const tf = TF_MS[timeframe];
  const offset = alignmentOffset(timeframe);
  return Math.floor((now + offset) / tf) * tf - offset;
}

export function expectedLatestClosedOpen(now: number, timeframe: Timeframe): number {
  if (isMonthly(timeframe)) return previousMonthStart(now, timeframe);
  if (timeframe === '1W' || timeframe === '1Wutc') return weekStart(now, timeframe) - TF_MS[timeframe];
  const tf = TF_MS[timeframe];
  const offset = alignmentOffset(timeframe);
  const t = now - CLOSE_GRACE_MS;
  return Math.floor((t + offset) / tf) * tf - tf - offset;
}

export function nextBarOpen(openTime: number, timeframe: Timeframe): number {
  if (isMonthly(timeframe)) {
    const offset = alignmentOffset(timeframe);
    const date = new Date(openTime + offset);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + monthSpan(timeframe), 1) - offset;
  }
  return openTime + TF_MS[timeframe];
}

export function candleCloseTime(candle: Pick<Candle, 'openTime' | 'timeframe'>): number {
  return nextBarOpen(candle.openTime, candle.timeframe);
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
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].openTime !== nextBarOpen(recent[i - 1].openTime, recent[i - 1].timeframe)) return false;
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
    latestClosedAt: latest ? candleCloseTime(latest) : null,
    lastReceivedAt: null,
    bars: candles.length,
  };
}

export function isOlderThanOneBar(latest: Candle | null, now: number, timeframe: Timeframe): boolean {
  if (!latest) return true;
  return now - candleCloseTime(latest) > TF_MS[timeframe] + CLOSE_GRACE_MS;
}
