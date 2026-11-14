import { registerIndicator, type IndicatorDrawParams, type KLineData } from 'klinecharts';
import {
  bollingerBands,
  kdj,
  macd,
  rsi,
  sma,
  volumeMovingAverage,
  type Ohlcv,
} from '../../../shared/indicators';
import { CHART_COLORS } from './chartTheme';

const LINE_COLORS = ['#71a7ff', '#9e8cff', '#f0c06a', '#d38bff', '#efb45d'];

function toCandles(data: KLineData[]): Ohlcv[] {
  return data.map((bar) => ({
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.turnover ?? bar.volume ?? 0,
  }));
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function drawVolume(ctx: CanvasRenderingContext2D, params: IndicatorDrawParams<unknown, number, unknown>): boolean {
  const { chart, indicator, xAxis, yAxis } = params;
  const data = chart.getDataList();
  const result = indicator.result as Array<{ volume?: number | null; ma?: number | null }>;
  const range = chart.getVisibleRange();
  const barSpace = chart.getBarSpace().bar;
  const zeroY = yAxis.convertToPixel(0);
  const from = Math.max(0, range.from);
  const to = Math.min(data.length - 1, range.to);
  ctx.save();
  for (let i = from; i <= to; i++) {
    const value = result[i]?.volume;
    if (value === null || value === undefined || !Number.isFinite(value)) continue;
    const bar = data[i];
    const x = xAxis.convertTimestampToPixel(bar.timestamp);
    const y = yAxis.convertToPixel(value);
    ctx.fillStyle = bar.close >= bar.open ? CHART_COLORS.volumeUp : CHART_COLORS.volumeDown;
    ctx.fillRect(x - barSpace * 0.36, Math.min(y, zeroY), Math.max(1, barSpace * 0.72), Math.max(1, Math.abs(zeroY - y)));
  }
  ctx.strokeStyle = '#d7b875';
  ctx.lineWidth = 1;
  ctx.beginPath();
  let started = false;
  for (let i = from; i <= to; i++) {
    const value = result[i]?.ma;
    if (value === null || value === undefined || !Number.isFinite(value)) {
      started = false;
      continue;
    }
    const x = xAxis.convertTimestampToPixel(data[i].timestamp);
    const y = yAxis.convertToPixel(value);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
  return true;
}

function drawMacd(ctx: CanvasRenderingContext2D, params: IndicatorDrawParams<unknown, number, unknown>): boolean {
  const { chart, indicator, xAxis, yAxis } = params;
  const data = chart.getDataList();
  const result = indicator.result as Array<{ hist?: number | null; dif?: number | null; dea?: number | null }>;
  const range = chart.getVisibleRange();
  const barSpace = chart.getBarSpace().bar;
  const zeroY = yAxis.convertToPixel(0);
  const from = Math.max(0, range.from);
  const to = Math.min(data.length - 1, range.to);
  ctx.save();
  for (let i = from; i <= to; i++) {
    const value = result[i]?.hist;
    if (value === null || value === undefined || !Number.isFinite(value)) continue;
    const x = xAxis.convertTimestampToPixel(data[i].timestamp);
    const y = yAxis.convertToPixel(value);
    ctx.fillStyle = value >= 0 ? 'rgba(47,212,134,.53)' : 'rgba(240,97,106,.53)';
    ctx.fillRect(x - barSpace * 0.32, Math.min(y, zeroY), Math.max(1, barSpace * 0.64), Math.max(1, Math.abs(zeroY - y)));
  }
  for (const [key, color] of [['dif', '#71a7ff'], ['dea', '#efb45d']] as const) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    let started = false;
    for (let i = from; i <= to; i++) {
      const value = result[i]?.[key];
      if (value === null || value === undefined || !Number.isFinite(value)) {
        started = false;
        continue;
      }
      const x = xAxis.convertTimestampToPixel(data[i].timestamp);
      const y = yAxis.convertToPixel(value);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();
  return true;
}

let registered = false;

export function registerChartIndicators(): void {
  if (registered) return;
  registered = true;

  registerIndicator({
    name: 'MS_BOLL',
    shortName: 'BOLL',
    series: 'price',
    precision: 2,
    calcParams: [20, 2],
    figures: [
      { key: 'upper', title: 'UP:', type: 'line' },
      { key: 'middle', title: 'MID:', type: 'line' },
      { key: 'lower', title: 'LOW:', type: 'line' },
    ],
    styles: { lines: LINE_COLORS.slice(0, 3).map((color) => ({ color, size: 1 })) },
    calc: (dataList, indicator) => {
      const [length, mult] = indicator.calcParams as number[];
      const bands = bollingerBands(toCandles(dataList), { length, mult, slopeWindow: 1 });
      return dataList.map((_, i) => ({
        upper: finite(bands.upper[i]),
        middle: finite(bands.middle[i]),
        lower: finite(bands.lower[i]),
      }));
    },
  });

  registerIndicator({
    name: 'MS_VOL',
    shortName: 'VOL',
    series: 'volume',
    precision: 2,
    calcParams: [20],
    figures: [
      { key: 'volume', title: 'VOL:', type: 'line' },
      { key: 'ma', title: 'MA:', type: 'line' },
    ],
    styles: { lines: [{ color: '#d7b875', size: 1 }] },
    calc: (dataList, indicator) => {
      const [maLength] = indicator.calcParams as number[];
      const candles = toCandles(dataList);
      const average = volumeMovingAverage(candles, { maLength });
      return dataList.map((bar, i) => ({ volume: bar.turnover ?? bar.volume ?? 0, ma: finite(average[i]) }));
    },
    draw: (params) => drawVolume(params.ctx, params),
  });

  registerIndicator({
    name: 'MS_KDJ',
    shortName: 'KDJ',
    series: 'normal',
    precision: 2,
    calcParams: [9, 3, 3],
    figures: [
      { key: 'k', title: 'K:', type: 'line' },
      { key: 'd', title: 'D:', type: 'line' },
      { key: 'j', title: 'J:', type: 'line' },
    ],
    styles: { lines: LINE_COLORS.slice(0, 3).map((color) => ({ color, size: 1 })) },
    calc: (dataList, indicator) => {
      const [length, kSmooth, dSmooth] = indicator.calcParams as number[];
      const values = kdj(toCandles(dataList), { length, kSmooth, dSmooth });
      return dataList.map((_, i) => ({
        k: finite(values.k[i]),
        d: finite(values.d[i]),
        j: finite(values.j[i]),
      }));
    },
  });

  registerIndicator({
    name: 'MS_RSI',
    shortName: 'RSI',
    series: 'normal',
    precision: 2,
    calcParams: [14],
    figures: [{ key: 'rsi', title: 'RSI:', type: 'line' }],
    styles: { lines: [{ color: '#f08a6a', size: 1.3 }] },
    calc: (dataList, indicator) => {
      const [length] = indicator.calcParams as number[];
      const values = rsi(toCandles(dataList), { length });
      return dataList.map((_, i) => ({ rsi: finite(values[i]) }));
    },
  });

  registerIndicator({
    name: 'MS_MACD',
    shortName: 'MACD',
    series: 'normal',
    precision: 2,
    calcParams: [12, 26, 9],
    figures: [
      { key: 'hist', title: 'HIST:', type: 'line' },
      { key: 'dif', title: 'DIF:', type: 'line' },
      { key: 'dea', title: 'DEA:', type: 'line' },
    ],
    styles: { lines: LINE_COLORS.slice(0, 3).map((color) => ({ color, size: 1 })) },
    calc: (dataList, indicator) => {
      const [fast, slow, signal] = indicator.calcParams as number[];
      const values = macd(toCandles(dataList), { fast, slow, signal });
      return dataList.map((_, i) => ({
        hist: finite(values.hist[i]),
        dif: finite(values.dif[i]),
        dea: finite(values.dea[i]),
      }));
    },
    draw: (params) => drawMacd(params.ctx, params),
  });

  registerIndicator({
    name: 'MS_MA',
    shortName: 'MA',
    series: 'price',
    precision: 2,
    calcParams: [5, 10, 20, 60],
    figures: [
      { key: 'ma0', title: 'MA5:', type: 'line' },
      { key: 'ma1', title: 'MA10:', type: 'line' },
      { key: 'ma2', title: 'MA20:', type: 'line' },
      { key: 'ma3', title: 'MA60:', type: 'line' },
    ],
    styles: { lines: LINE_COLORS.map((color) => ({ color, size: 1 })) },
    calc: (dataList, indicator) => {
      const periods = indicator.calcParams as number[];
      const closes = dataList.map((bar) => bar.close);
      const values = periods.slice(0, 4).map((period) => sma(closes, period));
      return dataList.map((_, i) => ({
        ma0: finite(values[0]?.[i]),
        ma1: finite(values[1]?.[i]),
        ma2: finite(values[2]?.[i]),
        ma3: finite(values[3]?.[i]),
      }));
    },
  });
}

export const INDICATOR_NAMES: Record<string, string> = {
  boll: 'MS_BOLL',
  volume: 'MS_VOL',
  kdj: 'MS_KDJ',
  rsi: 'MS_RSI',
  macd: 'MS_MACD',
  ma: 'MS_MA',
};

