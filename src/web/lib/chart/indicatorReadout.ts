import type { KLineData } from 'klinecharts';
import {
  bollingerBands,
  kdj,
  macd,
  rsi,
  sma,
  volumeMovingAverage,
  type Ohlcv,
} from '../../../shared/indicators';
import type { ChartIndicatorConfig, IndicatorLegendItem } from './types';

function candles(data: KLineData[]): Ohlcv[] {
  return data.map((bar) => ({
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.turnover ?? bar.volume ?? 0,
  }));
}

function value(values: Array<number | null>, index: number): number | null {
  const item = values[index];
  return typeof item === 'number' && Number.isFinite(item) ? item : null;
}

/**
 * Compute the same series the KLineChart custom indicators use, at the
 * crosshair (or latest) index. Used for the exchange-style DOM legend.
 */
export function computeIndicatorLegend(
  config: ChartIndicatorConfig,
  data: KLineData[],
  index = data.length - 1,
): IndicatorLegendItem[] {
  const items: IndicatorLegendItem[] = [];
  if (!data.length) return items;
  const i = Math.max(0, Math.min(data.length - 1, index));
  const bars = candles(data);
  if (config.boll.enabled) {
    const bands = bollingerBands(bars, { length: config.boll.length, mult: config.boll.mult, slopeWindow: 1 });
    items.push({
      key: 'boll',
      name: 'BOLL',
      params: `(${config.boll.length},${config.boll.mult})`,
      values: [
        { label: 'U', value: value(bands.upper, i) },
        { label: 'M', value: value(bands.middle, i) },
        { label: 'L', value: value(bands.lower, i) },
      ],
      visible: config.boll.visible,
    });
  }
  if (config.volume.enabled) {
    const average = volumeMovingAverage(bars, { maLength: config.volume.maLength });
    items.push({
      key: 'volume',
      name: 'VOL',
      params: `(MA${config.volume.maLength})`,
      values: [
        { label: 'VOL', value: data[i]?.turnover ?? data[i]?.volume ?? null },
        { label: 'MA', value: value(average, i) },
      ],
      visible: config.volume.visible,
    });
  }
  if (config.kdj.enabled) {
    const result = kdj(bars, {
      length: config.kdj.length,
      kSmooth: config.kdj.kSmooth,
      dSmooth: config.kdj.dSmooth,
    });
    items.push({
      key: 'kdj',
      name: 'KDJ',
      params: `(${config.kdj.length},${config.kdj.kSmooth},${config.kdj.dSmooth})`,
      values: [
        { label: 'K', value: value(result.k, i) },
        { label: 'D', value: value(result.d, i) },
        { label: 'J', value: value(result.j, i) },
      ],
      visible: config.kdj.visible,
    });
  }
  if (config.rsi.enabled) {
    const result = rsi(bars, { length: config.rsi.length });
    items.push({
      key: 'rsi',
      name: 'RSI',
      params: `(${config.rsi.length})`,
      values: [{ label: 'RSI', value: value(result, i) }],
      visible: config.rsi.visible,
    });
  }
  if (config.macd.enabled) {
    const result = macd(bars, {
      fast: config.macd.fast,
      slow: config.macd.slow,
      signal: config.macd.signal,
    });
    items.push({
      key: 'macd',
      name: 'MACD',
      params: `(${config.macd.fast},${config.macd.slow},${config.macd.signal})`,
      values: [
        { label: 'DIF', value: value(result.dif, i) },
        { label: 'DEA', value: value(result.dea, i) },
        { label: 'HIST', value: value(result.hist, i) },
      ],
      visible: config.macd.visible,
    });
  }
  if (config.ma.enabled) {
    const periods = [...config.ma.periods, 5, 10, 20, 60].slice(0, 4);
    const closes = bars.map((bar) => bar.close);
    items.push({
      key: 'ma',
      name: 'MA',
      params: `(${periods.join(',')})`,
      values: periods.map((period, k) => ({
        label: `MA${period}`,
        value: value(sma(closes, period), i),
      })),
      visible: config.ma.visible,
    });
  }
  return items;
}
