import { useEffect, useMemo, useRef } from 'react';
import * as echarts from 'echarts';
import type { Candle } from '../../shared/types';
import { bollingerBands } from '../../server/indicators';
import { formatNumber, formatTime } from '../lib/format';

export interface ChartMarker {
  triggerAt: number;
  price: number;
  label?: string;
}

export function MarketChart({
  candles,
  timeframe,
  markers = [],
  height = 320,
  compact = false,
  showBollinger = true,
  ariaLabel = '行情 K 线图',
}: {
  candles: Candle[];
  timeframe: string;
  markers?: ChartMarker[];
  height?: number;
  compact?: boolean;
  showBollinger?: boolean;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const computed = useMemo(() => {
    if (!candles.length) return null;
    const bands = bollingerBands(candles, { length: 20, mult: 2, slopeWindow: 1 });
    const volumeMax = Math.max(...candles.map((candle) => candle.volume), 1);
    return { bands, volumeMax };
  }, [candles]);

  useEffect(() => {
    if (!ref.current || !computed || !candles.length) return;
    const chart = chartRef.current ?? echarts.init(ref.current, undefined, { renderer: 'canvas' });
    chartRef.current = chart;
    const labels = candles.map((candle) => formatTime(candle.openTime));
    const candleData = candles.map((candle) => [candle.open, candle.close, candle.low, candle.high]);
    const markerData = markers
      .map((marker) => {
        let best = -1;
        for (let i = 0; i < candles.length; i++) {
          if (candles[i].openTime <= marker.triggerAt) best = i;
          else break;
        }
        return best >= 0 ? { index: best, marker } : null;
      })
      .filter((item): item is { index: number; marker: ChartMarker } => Boolean(item))
      .slice(-60)
      .map((item) => ({
        value: [item.index, item.marker.price],
        label: {
          show: true,
          formatter: item.marker.label ?? '触发',
          color: '#d7b875',
          fontSize: 8,
          position: 'top',
        },
      }));
    const muted = '#5c7081';
    chart.setOption(
      {
        animation: false,
        backgroundColor: 'transparent',
        textStyle: { fontFamily: 'PingFang SC, Microsoft YaHei, sans-serif' },
        grid: [
          { left: 10, right: 54, top: 18, height: '62%' },
          { left: 10, right: 54, top: '77%', height: '17%' },
        ],
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'cross', crossStyle: { color: '#415768' } },
          backgroundColor: 'rgba(10,17,24,.96)',
          borderColor: '#2b3d4b',
          textStyle: { color: '#cbd9e5', fontSize: 10 },
        },
        axisPointer: { link: [{ xAxisIndex: 'all' }] },
        xAxis: [
          {
            type: 'category',
            data: labels,
            boundaryGap: true,
            axisLine: { lineStyle: { color: '#20303c' } },
            axisTick: { show: false },
            axisLabel: {
              color: muted,
              fontSize: 8.5,
              interval: Math.max(1, Math.floor(Math.min(candles.length, 120) / 6)),
              hideOverlap: false,
            },
            splitLine: { show: false },
          },
          {
            type: 'category',
            gridIndex: 1,
            data: labels,
            boundaryGap: true,
            axisLine: { show: false },
            axisTick: { show: false },
            axisLabel: { show: false },
            splitLine: { show: false },
          },
        ],
        yAxis: [
          {
            scale: true,
            position: 'right',
            axisLabel: { color: muted, fontSize: 8.5, formatter: (value: number) => formatNumber(value, 0) },
            splitLine: { lineStyle: { color: '#17232d', type: 'dashed' } },
            axisLine: { show: false },
            axisTick: { show: false },
          },
          {
            scale: true,
            gridIndex: 1,
            position: 'right',
            axisLabel: { show: false },
            splitLine: { show: false },
            axisLine: { show: false },
            axisTick: { show: false },
          },
        ],
        dataZoom: [
          {
            type: 'inside',
            xAxisIndex: [0, 1],
            start: Math.max(0, 100 - (120 / Math.max(candles.length, 1)) * 100),
            end: 100,
          },
        ],
        series: [
          {
            name: 'K 线',
            type: 'candlestick',
            data: candleData,
            itemStyle: {
              color: '#2fd486',
              color0: '#f0616a',
              borderColor: '#2fd486',
              borderColor0: '#f0616a',
            },
            barMaxWidth: 8,
          },
          ...(showBollinger
            ? [
                {
                  name: 'BOLL 上轨',
                  type: 'line',
                  data: computed.bands.upper,
                  symbol: 'none',
                  lineStyle: { color: '#71a7ff', width: 1, opacity: 0.55 },
                  itemStyle: { color: '#71a7ff' },
                },
                {
                  name: 'BOLL 中轨',
                  type: 'line',
                  data: computed.bands.middle,
                  symbol: 'none',
                  lineStyle: { color: '#9e8cff', width: 1, opacity: 0.55, type: 'dashed' },
                  itemStyle: { color: '#9e8cff' },
                },
                {
                  name: 'BOLL 下轨',
                  type: 'line',
                  data: computed.bands.lower,
                  symbol: 'none',
                  lineStyle: { color: '#71a7ff', width: 1, opacity: 0.55 },
                  itemStyle: { color: '#71a7ff' },
                },
              ]
            : []),
          {
            name: '触发',
            type: 'scatter',
            data: markerData,
            symbolSize: 7,
            itemStyle: { color: '#efb45d', borderColor: '#080d13', borderWidth: 1 },
            z: 12,
          },
          {
            name: '成交量',
            type: 'bar',
            xAxisIndex: 1,
            yAxisIndex: 1,
            data: candles.map((candle) => ({
              value: candle.volume,
              itemStyle: {
                color: candle.close >= candle.open ? 'rgba(47,212,134,.28)' : 'rgba(240,97,106,.28)',
              },
            })),
            barMaxWidth: 7,
          },
        ],
      },
      true,
    );
    const resize = () => chart.resize();
    const observer = new ResizeObserver(resize);
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [candles, computed, markers, showBollinger]);

  useEffect(
    () => () => {
      chartRef.current?.dispose();
      chartRef.current = null;
    },
    [],
  );

  if (!candles.length) {
    return (
      <div className={`chart-box${compact ? ' compact' : ''}`} style={{ height }}>
        <div className="chart-empty">暂无 K 线数据（规则启用后会自动加载）</div>
      </div>
    );
  }
  return (
    <div
      ref={ref}
      className={`chart-box${compact ? ' compact' : ''}`}
      style={{ height }}
      role="img"
      aria-label={`${ariaLabel} · ${timeframe}`}
    />
  );
}
