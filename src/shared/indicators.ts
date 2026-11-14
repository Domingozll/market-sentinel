import {
  type IndicatorParams,
  type SeriesKey,
  normalizeParams,
} from '../shared/types';

export interface Ohlcv {
  open: number;
  high: number;
  low: number;
  close: number;
  /** Quote-currency turnover (OKX volCcyQuote). */
  volume: number;
}

export type Series = (number | null)[];

export interface BollingerBands {
  upper: Series;
  middle: Series;
  lower: Series;
  bandwidth: Series;
  percentB: Series;
  midSlope: Series;
}

export function sma(values: number[], period: number): Series {
  const out: Series = Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** EMA seeded with the SMA of the first period values. Null before the seed. */
export function ema(values: number[], period: number): Series {
  const out: Series = Array(values.length).fill(null);
  if (period <= 0) return out;
  const alpha = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < period) {
      seed += values[i];
      if (i === period - 1) out[i] = seed / period;
    } else {
      const previous = out[i - 1];
      if (previous === null) break;
      out[i] = values[i] * alpha + previous * (1 - alpha);
    }
  }
  return out;
}

export function bollingerBands(candles: Ohlcv[], config: IndicatorParams): BollingerBands {
  const params = normalizeParams('bb.middle', { ...config });
  const period = Math.max(2, Math.round(params.length ?? 20));
  const mult = Math.max(0.1, Number(params.mult ?? 2));
  const slopeWindow = Math.max(1, Math.round(params.slopeWindow ?? 1));
  const n = candles.length;
  const upper: Series = Array(n).fill(null);
  const middle: Series = Array(n).fill(null);
  const lower: Series = Array(n).fill(null);
  const bandwidth: Series = Array(n).fill(null);
  const percentB: Series = Array(n).fill(null);
  const midSlope: Series = Array(n).fill(null);

  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const close = candles[i].close;
    sum += close;
    sumSq += close * close;
    if (i >= period) {
      const old = candles[i - period].close;
      sum -= old;
      sumSq -= old * old;
    }
    if (i < period - 1) continue;
    const mean = sum / period;
    const variance = Math.max(0, sumSq / period - mean * mean);
    const sd = Math.sqrt(variance);
    const up = mean + mult * sd;
    const low = mean - mult * sd;
    middle[i] = mean;
    upper[i] = up;
    lower[i] = low;
    bandwidth[i] = mean === 0 ? null : ((up - low) / Math.abs(mean)) * 100;
    const width = up - low;
    percentB[i] = width === 0 ? null : (close - low) / width;
    if (i >= period - 1 + slopeWindow) {
      const previous = middle[i - slopeWindow];
      if (previous !== null && previous !== 0) {
        midSlope[i] = ((mean - previous) / Math.abs(previous)) * 100 / slopeWindow;
      }
    }
  }
  return { upper, middle, lower, bandwidth, percentB, midSlope };
}

export interface KdjSeries {
  k: Series;
  d: Series;
  j: Series;
}

export function kdj(candles: Ohlcv[], config: IndicatorParams): KdjSeries {
  const params = normalizeParams('kdj.k', { ...config });
  const period = Math.max(2, Math.round(params.length ?? 9));
  const kSmooth = Math.max(1, Math.round(params.kSmooth ?? 3));
  const dSmooth = Math.max(1, Math.round(params.dSmooth ?? 3));
  const n = candles.length;
  const k: Series = Array(n).fill(null);
  const d: Series = Array(n).fill(null);
  const j: Series = Array(n).fill(null);
  let previousK = 50;
  let previousD = 50;

  for (let i = period - 1; i < n; i++) {
    let highest = -Infinity;
    let lowest = Infinity;
    for (let x = i - period + 1; x <= i; x++) {
      if (candles[x].high > highest) highest = candles[x].high;
      if (candles[x].low < lowest) lowest = candles[x].low;
    }
    const range = highest - lowest;
    const rsv = range === 0 ? 50 : ((candles[i].close - lowest) / range) * 100;
    const currentK = ((kSmooth - 1) * previousK + rsv) / kSmooth;
    const currentD = ((dSmooth - 1) * previousD + currentK) / dSmooth;
    const currentJ = 3 * currentK - 2 * currentD;
    k[i] = currentK;
    d[i] = currentD;
    j[i] = currentJ;
    previousK = currentK;
    previousD = currentD;
  }
  return { k, d, j };
}

export function rsi(candles: Ohlcv[], config: IndicatorParams): Series {
  const params = normalizeParams('rsi.rsi', { ...config });
  const period = Math.max(2, Math.round(params.length ?? 14));
  const out: Series = Array(candles.length).fill(null);
  if (candles.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change > 0) gainSum += change;
    else lossSum += -change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = rsiValue(avgGain, avgLoss);

  for (let i = period + 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiValue(avgGain, avgLoss);
  }
  return out;
}

function rsiValue(avgGain: number, avgLoss: number): number {
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface MacdSeries {
  dif: Series;
  dea: Series;
  hist: Series;
}

export function macd(candles: Ohlcv[], config: IndicatorParams): MacdSeries {
  const params = normalizeParams('macd.dif', { ...config });
  const fast = Math.max(2, Math.round(params.fast ?? 12));
  const slow = Math.max(fast + 1, Math.round(params.slow ?? 26));
  const signal = Math.max(2, Math.round(params.signal ?? 9));
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const dif: Series = Array(n).fill(null);
  const dea: Series = Array(n).fill(null);
  const hist: Series = Array(n).fill(null);

  for (let i = slow - 1; i < n; i++) {
    if (fastEma[i] !== null && slowEma[i] !== null) {
      dif[i] = (fastEma[i] as number) - (slowEma[i] as number);
    }
  }
  const deaStart = slow - 1 + signal - 1;
  if (deaStart < n) {
    let seed = 0;
    for (let i = slow - 1; i <= deaStart; i++) seed += dif[i] as number;
    dea[deaStart] = seed / signal;
    const alpha = 2 / (signal + 1);
    for (let i = deaStart + 1; i < n; i++) {
      dea[i] = (dif[i] as number) * alpha + (dea[i - 1] as number) * (1 - alpha);
    }
  }
  for (let i = 0; i < n; i++) {
    if (dif[i] !== null && dea[i] !== null) {
      hist[i] = (dif[i] as number) - (dea[i] as number);
    }
  }
  return { dif, dea, hist };
}

export function volumeMovingAverage(candles: Ohlcv[], config: IndicatorParams): Series {
  const params = normalizeParams('volume.ma', { ...config });
  const period = Math.max(1, Math.round(params.maLength ?? 20));
  return sma(candles.map((c) => c.volume), period);
}

export function volumeRatio(candles: Ohlcv[], config: IndicatorParams): Series {
  const average = volumeMovingAverage(candles, config);
  return candles.map((c, i) => {
    const base = average[i];
    if (base === null || base === 0) return null;
    return c.volume / base;
  });
}

export function computeSeries(candles: Ohlcv[], series: SeriesKey, rawParams?: IndicatorParams): Series {
  switch (series) {
    case 'price.open':
      return candles.map((c) => c.open);
    case 'price.high':
      return candles.map((c) => c.high);
    case 'price.low':
      return candles.map((c) => c.low);
    case 'price.close':
      return candles.map((c) => c.close);
    case 'bb.upper':
      return bollingerBands(candles, rawParams ?? {}).upper;
    case 'bb.middle':
      return bollingerBands(candles, rawParams ?? {}).middle;
    case 'bb.lower':
      return bollingerBands(candles, rawParams ?? {}).lower;
    case 'bb.bandwidth':
      return bollingerBands(candles, rawParams ?? {}).bandwidth;
    case 'bb.percentB':
      return bollingerBands(candles, rawParams ?? {}).percentB;
    case 'bb.midSlope':
      return bollingerBands(candles, rawParams ?? {}).midSlope;
    case 'kdj.k':
      return kdj(candles, rawParams ?? {}).k;
    case 'kdj.d':
      return kdj(candles, rawParams ?? {}).d;
    case 'kdj.j':
      return kdj(candles, rawParams ?? {}).j;
    case 'rsi.rsi':
      return rsi(candles, rawParams ?? {});
    case 'macd.dif':
      return macd(candles, rawParams ?? {}).dif;
    case 'macd.dea':
      return macd(candles, rawParams ?? {}).dea;
    case 'macd.hist':
      return macd(candles, rawParams ?? {}).hist;
    case 'volume.quote':
      return candles.map((c) => c.volume);
    case 'volume.ma':
      return volumeMovingAverage(candles, rawParams ?? {});
    case 'volume.ratio':
      return volumeRatio(candles, rawParams ?? {});
    default: {
      const exhaustive: never = series;
      throw new Error(`Unknown series: ${String(exhaustive)}`);
    }
  }
}

export function compareValues(left: number, cmp: 'gt' | 'gte' | 'lt' | 'lte', right: number): boolean {
  switch (cmp) {
    case 'gt':
      return left > right;
    case 'gte':
      return left >= right;
    case 'lt':
      return left < right;
    case 'lte':
      return left <= right;
    default: {
      const exhaustive: never = cmp;
      throw new Error(`Unknown comparator: ${String(exhaustive)}`);
    }
  }
}
