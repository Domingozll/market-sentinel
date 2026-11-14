import { useEffect, useMemo, useRef } from 'react';
import * as echarts from 'echarts';
import type { Candle } from '../../shared/types';
import {
  bollingerBands,
  kdj,
  macd,
  rsi,
  volumeMovingAverage,
} from '../../shared/indicators';
import { formatCompact, formatNumber, formatTime } from '../lib/format';
import {
  activeChartSubPanes,
  DEFAULT_CHART_INDICATORS,
  type ChartIndicatorSettings,
  type ChartSubPaneKey,
} from '../lib/chartIndicators';

export interface ChartMarker {
  triggerAt: number;
  price: number;
  label?: string;
}

const PANE_COLORS = {
  boll: '#71a7ff',
  bollMiddle: '#9e8cff',
  volume: '#8bd17c',
  volumeMa: '#d7b875',
  kdjK: '#f0c06a',
  kdjD: '#71a7ff',
  kdjJ: '#d38bff',
  rsi: '#f08a6a',
  macdDif: '#71a7ff',
  macdDea: '#efb45d',
  macdUp: 'rgba(47,212,134,.42)',
  macdDown: 'rgba(240,97,106,.42)',
  guide: '#2b3d4b',
};

const LAYOUT = {
  top: 16,
  bottom: 10,
  priceHeight: 220,
  gap: 18,
  paneHeight: 72,
  paneGap: 12,
} as const;

function yAxisForPane(pane: ChartSubPaneKey, gridIndex: number) {
  const common = {
    gridIndex,
    position: 'right' as const,
    axisLine: { show: false },
    axisTick: { show: false },
    splitLine: { show: false },
    axisLabel: { color: '#5c7081', fontSize: 8.5 },
  };
  switch (pane) {
    case 'volume':
      return {
        ...common,
        min: 0,
        splitNumber: 2,
        axisLabel: { ...common.axisLabel, formatter: (value: number) => formatCompact(value) },
      };
    case 'kdj':
      return {
        ...common,
        scale: true,
        splitNumber: 2,
        axisLabel: { ...common.axisLabel, formatter: (value: number) => formatNumber(value, 0) },
      };
    case 'rsi':
      return {
        ...common,
        min: 0,
        max: 100,
        interval: 50,
        axisLabel: { ...common.axisLabel, formatter: (value: number) => formatNumber(value, 0) },
      };
    case 'macd':
      return {
        ...common,
        scale: true,
        splitNumber: 2,
        axisLabel: { ...common.axisLabel, formatter: (value: number) => formatNumber(value, 2) },
      };
    default: {
      const exhaustive: never = pane;
      throw new Error(`Unknown chart pane: ${String(exhaustive)}`);
    }
  }
}

function guideLines(values: number[]) {
  return {
    silent: true,
    symbol: 'none',
    label: { show: false },
    lineStyle: { color: PANE_COLORS.guide, width: 1, type: 'dashed' as const },
    data: values.map((value) => ({ yAxis: value })),
  };
}

export function MarketChart({
  candles,
  timeframe,
  markers = [],
  height = 320,
  compact = false,
  showBollinger = true,
  indicatorSettings,
  ariaLabel = '行情 K 线图',
}: {
  candles: Candle[];
  timeframe: string;
  markers?: ChartMarker[];
  height?: number;
  compact?: boolean;
  showBollinger?: boolean;
  indicatorSettings?: ChartIndicatorSettings;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  const settings = useMemo<ChartIndicatorSettings>(() => {
    if (indicatorSettings) return indicatorSettings;
    return {
      ...DEFAULT_CHART_INDICATORS,
      boll: { ...DEFAULT_CHART_INDICATORS.boll, enabled: showBollinger },
      volume: { ...DEFAULT_CHART_INDICATORS.volume, enabled: true },
    };
  }, [indicatorSettings, showBollinger]);

  const subPanes = useMemo(() => activeChartSubPanes(settings), [settings]);
  const compactLayout = compact && !indicatorSettings;

  const computed = useMemo(() => {
    if (!candles.length) return null;
    return {
      bands: settings.boll.enabled
        ? bollingerBands(candles, { length: settings.boll.length, mult: settings.boll.mult, slopeWindow: 1 })
        : null,
      volumeMa: settings.volume.enabled
        ? volumeMovingAverage(candles, { maLength: settings.volume.maLength })
        : null,
      kdj: settings.kdj.enabled
        ? kdj(candles, settings.kdj)
        : null,
      rsi: settings.rsi.enabled
        ? rsi(candles, { length: settings.rsi.length })
        : null,
      macd: settings.macd.enabled
        ? macd(candles, settings.macd)
        : null,
    };
  }, [candles, settings]);

  const paneCount = subPanes.length;
  const computedHeight = paneCount
    ? LAYOUT.top + LAYOUT.priceHeight + LAYOUT.gap + paneCount * LAYOUT.paneHeight
      + Math.max(0, paneCount - 1) * LAYOUT.paneGap + LAYOUT.bottom
    : Math.max(height, 300);
  const chartHeight = compactLayout ? height : computedHeight;

  useEffect(() => {
    if (!ref.current || !computed || !candles.length) return;
    const chart = chartRef.current ?? echarts.init(ref.current, undefined, { renderer: 'canvas' });
    chartRef.current = chart;
    chart.resize();

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

    const grids = [
      {
        left: 10,
        right: 54,
        top: compactLayout ? 18 : LAYOUT.top,
        height: compactLayout
          ? '62%'
          : paneCount ? LAYOUT.priceHeight : Math.max(120, chartHeight - LAYOUT.top - LAYOUT.bottom),
      },
      ...subPanes.map((_, index) => ({
        left: 10,
        right: 54,
        top: compactLayout
          ? '77%'
          : LAYOUT.top + LAYOUT.priceHeight + LAYOUT.gap + index * (LAYOUT.paneHeight + LAYOUT.paneGap),
        height: compactLayout ? '17%' : LAYOUT.paneHeight,
      })),
    ];

    const mainXAxis = {
      type: 'category' as const,
      data: labels,
      boundaryGap: true,
      gridIndex: 0,
      axisLine: { lineStyle: { color: '#20303c' } },
      axisTick: { show: false },
      axisLabel: {
        color: '#5c7081',
        fontSize: 8.5,
        interval: Math.max(1, Math.floor(Math.min(candles.length, 120) / 6)),
        hideOverlap: false,
      },
      splitLine: { show: false },
    };
    const subXAxes = subPanes.map((_, index) => ({
      type: 'category' as const,
      data: labels,
      boundaryGap: true,
      gridIndex: index + 1,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { show: false },
      splitLine: { show: false },
    }));

    const mainYAxis = {
      gridIndex: 0,
      scale: true,
      position: 'right' as const,
      axisLabel: { color: '#5c7081', fontSize: 8.5, formatter: (value: number) => formatNumber(value, 0) },
      splitLine: { lineStyle: { color: '#17232d', type: 'dashed' as const } },
      axisLine: { show: false },
      axisTick: { show: false },
    };
    const paneYAxes = subPanes.map((pane, index) => yAxisForPane(pane, index + 1));

    const series: Record<string, unknown>[] = [
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
    ];

    if (computed.bands) {
      series.push(
        {
          name: 'BOLL 上轨',
          type: 'line',
          data: computed.bands.upper,
          symbol: 'none',
          lineStyle: { color: PANE_COLORS.boll, width: 1, opacity: 0.55 },
          itemStyle: { color: PANE_COLORS.boll },
        },
        {
          name: 'BOLL 中轨',
          type: 'line',
          data: computed.bands.middle,
          symbol: 'none',
          lineStyle: { color: PANE_COLORS.bollMiddle, width: 1, opacity: 0.55, type: 'dashed' },
          itemStyle: { color: PANE_COLORS.bollMiddle },
        },
        {
          name: 'BOLL 下轨',
          type: 'line',
          data: computed.bands.lower,
          symbol: 'none',
          lineStyle: { color: PANE_COLORS.boll, width: 1, opacity: 0.55 },
          itemStyle: { color: PANE_COLORS.boll },
        },
      );
    }

    series.push({
      name: '触发',
      type: 'scatter',
      data: markerData,
      symbolSize: 7,
      itemStyle: { color: '#efb45d', borderColor: '#080d13', borderWidth: 1 },
      z: 12,
    });

    subPanes.forEach((pane, index) => {
      const paneIndex = index + 1;
      if (pane === 'volume') {
        series.push(
          {
            name: '成交量',
            type: 'bar',
            xAxisIndex: paneIndex,
            yAxisIndex: paneIndex,
            data: candles.map((candle) => ({
              value: candle.volume,
              itemStyle: {
                color: candle.close >= candle.open ? 'rgba(47,212,134,.28)' : 'rgba(240,97,106,.28)',
              },
            })),
            barMaxWidth: 7,
          },
          {
            name: `VOL MA(${settings.volume.maLength})`,
            type: 'line',
            xAxisIndex: paneIndex,
            yAxisIndex: paneIndex,
            data: computed.volumeMa,
            symbol: 'none',
            lineStyle: { color: PANE_COLORS.volumeMa, width: 1, opacity: 0.8 },
            itemStyle: { color: PANE_COLORS.volumeMa },
          },
        );
      } else if (pane === 'kdj' && computed.kdj) {
        series.push(
          {
            name: 'KDJ K',
            type: 'line',
            xAxisIndex: paneIndex,
            yAxisIndex: paneIndex,
            data: computed.kdj.k,
            symbol: 'none',
            lineStyle: { color: PANE_COLORS.kdjK, width: 1.2 },
            itemStyle: { color: PANE_COLORS.kdjK },
            markLine: guideLines([20, 80]),
          },
          {
            name: 'KDJ D',
            type: 'line',
            xAxisIndex: paneIndex,
            yAxisIndex: paneIndex,
            data: computed.kdj.d,
            symbol: 'none',
            lineStyle: { color: PANE_COLORS.kdjD, width: 1.2 },
            itemStyle: { color: PANE_COLORS.kdjD },
          },
          {
            name: 'KDJ J',
            type: 'line',
            xAxisIndex: paneIndex,
            yAxisIndex: paneIndex,
            data: computed.kdj.j,
            symbol: 'none',
            lineStyle: { color: PANE_COLORS.kdjJ, width: 1.1 },
            itemStyle: { color: PANE_COLORS.kdjJ },
          },
        );
      } else if (pane === 'rsi' && computed.rsi) {
        series.push({
          name: `RSI(${settings.rsi.length})`,
          type: 'line',
          xAxisIndex: paneIndex,
          yAxisIndex: paneIndex,
          data: computed.rsi,
          symbol: 'none',
          lineStyle: { color: PANE_COLORS.rsi, width: 1.3 },
          itemStyle: { color: PANE_COLORS.rsi },
          markLine: guideLines([30, 70]),
        });
      } else if (pane === 'macd' && computed.macd) {
        series.push(
          {
            name: 'MACD 柱',
            type: 'bar',
            xAxisIndex: paneIndex,
            yAxisIndex: paneIndex,
            data: computed.macd.hist.map((value) => ({
              value,
              itemStyle: { color: value !== null && value >= 0 ? PANE_COLORS.macdUp : PANE_COLORS.macdDown },
            })),
            barMaxWidth: 5,
            markLine: guideLines([0]),
          },
          {
            name: 'DIF',
            type: 'line',
            xAxisIndex: paneIndex,
            yAxisIndex: paneIndex,
            data: computed.macd.dif,
            symbol: 'none',
            lineStyle: { color: PANE_COLORS.macdDif, width: 1.3 },
            itemStyle: { color: PANE_COLORS.macdDif },
          },
          {
            name: 'DEA',
            type: 'line',
            xAxisIndex: paneIndex,
            yAxisIndex: paneIndex,
            data: computed.macd.dea,
            symbol: 'none',
            lineStyle: { color: PANE_COLORS.macdDea, width: 1.2 },
            itemStyle: { color: PANE_COLORS.macdDea },
          },
        );
      }
    });

    const allAxisIndexes = Array.from({ length: paneCount + 1 }, (_, index) => index);
    chart.setOption(
      {
        animation: false,
        backgroundColor: 'transparent',
        textStyle: { fontFamily: 'PingFang SC, Microsoft YaHei, sans-serif' },
        grid: grids,
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'cross', crossStyle: { color: '#415768' } },
          backgroundColor: 'rgba(10,17,24,.96)',
          borderColor: '#2b3d4b',
          textStyle: { color: '#cbd9e5', fontSize: 10 },
          confine: true,
        },
        axisPointer: { link: [{ xAxisIndex: 'all' }] },
        xAxis: [mainXAxis, ...subXAxes],
        yAxis: [mainYAxis, ...paneYAxes],
        dataZoom: [
          {
            type: 'inside',
            xAxisIndex: allAxisIndexes,
            start: Math.max(0, 100 - (120 / Math.max(candles.length, 1)) * 100),
            end: 100,
          },
        ],
        series,
      },
      true,
    );

    const resize = () => chart.resize();
    const observer = new ResizeObserver(resize);
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [candles, chartHeight, compactLayout, computed, markers, paneCount, settings, subPanes]);

  useEffect(
    () => () => {
      chartRef.current?.dispose();
      chartRef.current = null;
    },
    [],
  );

  if (!candles.length) {
    return (
      <div className={`chart-box${compact ? ' compact' : ''}`} style={{ height: chartHeight }}>
        <div className="chart-empty">暂无 K 线数据（规则启用后会自动加载）</div>
      </div>
    );
  }
  return (
    <div
      ref={ref}
      className={`chart-box${compact ? ' compact' : ''}`}
      style={{ height: chartHeight }}
      role="img"
      aria-label={`${ariaLabel} · ${timeframe} · ${subPanes.length ? subPanes.join('/') : '仅价格'}`}
      data-chart-indicators={subPanes.join(',')}
      data-testid="market-chart"
    />
  );
}
