import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  init,
  dispose,
  type Chart,
  type DeepPartial,
  type KLineData,
  type Styles,
} from 'klinecharts';
import { ChartDataLoader } from '../../lib/chart/dataLoader';
import {
  registerChartIndicators,
  INDICATOR_NAMES,
} from '../../lib/chart/indicatorRegistry';
import {
  registerEventMarkerOverlay,
  EVENT_MARKER_OVERLAY,
} from '../../lib/chart/eventMarkerOverlay';
import {
  registerVolumeProfileOverlay,
  forceVolumeProfileRedraw,
  VOLUME_PROFILE_OVERLAY,
  type VolumeProfileOverlayState,
} from '../../lib/chart/volumeProfileOverlay';
import { chartStyles } from '../../lib/chart/chartTheme';
import {
  DRAWING_GROUP,
  EVENT_GROUP,
  isDrawingTool,
  serializeDrawings,
} from '../../lib/chart/drawings';
import { computeVolumeProfile, type VolumeProfileResult } from '../../lib/chart/volumeProfile';
import type {
  ChartEventMarker,
  ChartIndicatorConfig,
  DrawingTool,
  OhlcvReadout,
  SerializedOverlay,
  VolumeProfileSettings,
} from '../../lib/chart/types';

export interface ProChartHandle {
  startDrawing: (tool: DrawingTool) => void;
  clearDrawings: () => void;
  scrollToLatest: () => void;
  screenshot: () => string | null;
}

export interface ProChartProps {
  symbol: string;
  timeframe: string;
  pricePrecision: number;
  volumePrecision: number;
  indicators: ChartIndicatorConfig;
  volumeProfile: VolumeProfileSettings;
  drawings: SerializedOverlay[];
  events: ChartEventMarker[];
  onDrawingsChange: (drawings: SerializedOverlay[]) => void;
  onDrawingDone?: () => void;
  onEventSelect: (event: ChartEventMarker) => void;
  onCrosshairChange: (readout: OhlcvReadout) => void;
  onVisibleProfile: (profile: VolumeProfileResult) => void;
  onChartStatus: (status: 'connecting' | 'live' | 'polling' | 'offline') => void;
  onError: (error: unknown) => void;
  onReady?: () => void;
}

const REFRESH_MS = 120;
const PROFIT_PROFILE_DEBOUNCE_MS = 180;

function toReadout(bar: KLineData | undefined): OhlcvReadout {
  if (!bar) return { timestamp: null, open: null, high: null, low: null, close: null, volume: null };
  return {
    timestamp: bar.timestamp,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.turnover ?? bar.volume ?? null,
  };
}

function barToProfile(bar: KLineData) {
  return { low: bar.low, high: bar.high, turnover: bar.turnover ?? bar.volume ?? 0 };
}

function serializeUserOverlays(chart: Chart): SerializedOverlay[] {
  return serializeDrawings(chart.getOverlays({ groupId: DRAWING_GROUP }));
}

export const ProChart = forwardRef<ProChartHandle, ProChartProps>(function ProChart(props, ref) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<Chart | null>(null);
  const loaderRef = useRef<ChartDataLoader | null>(null);
  const [ready, setReady] = useState(false);
  const propsRef = useRef(props);
  propsRef.current = props;
  const restoringDrawingsRef = useRef(false);
  const vpStateRef = useRef<VolumeProfileOverlayState>({
    settings: props.volumeProfile,
    revision: 0,
  });
  const refreshTimerRef = useRef<number | null>(null);
  const profileTimerRef = useRef<number | null>(null);

  const scheduleProfile = (chart: Chart): void => {
    if (profileTimerRef.current !== null) window.clearTimeout(profileTimerRef.current);
    profileTimerRef.current = window.setTimeout(() => {
      profileTimerRef.current = null;
      const range = chart.getVisibleRange();
      const bars = chart
        .getDataList()
        .slice(Math.max(0, range.from), range.to + 1)
        .map(barToProfile);
      propsRef.current.onVisibleProfile(computeVolumeProfile(bars, propsRef.current.volumeProfile.bins));
    }, PROFIT_PROFILE_DEBOUNCE_MS);
  };

  const scheduleRefresh = (chart: Chart): void => {
    if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      forceVolumeProfileRedraw(chart, vpStateRef.current);
      scheduleProfile(chart);
    }, REFRESH_MS);
  };

  // Mount the chart only once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    registerChartIndicators();
    registerVolumeProfileOverlay();
    registerEventMarkerOverlay();
    const chart = init(container, {
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
      styles: chartStyles as DeepPartial<Styles>,
      layout: {
        barSpaceLimit: { min: 2, max: 40 },
        pane: { minHeight: 76, dragEnabled: true },
        yAxis: { position: 'right' },
      },
    });
    if (!chart) return;
    chartRef.current = chart;
    const loader = new ChartDataLoader({
      symbol: propsRef.current.symbol,
      timeframe: propsRef.current.timeframe,
      onError: (error) => propsRef.current.onError(error),
      onStatus: (status) => propsRef.current.onChartStatus(status),
      onDataChange: () => {
        const current = chartRef.current;
        if (!current) return;
        const last = current.getDataList().at(-1);
        if (last) propsRef.current.onCrosshairChange(toReadout(last));
        scheduleRefresh(current);
      },
    });
    loaderRef.current = loader;
    chart.setSymbol({
      ticker: propsRef.current.symbol,
      pricePrecision: propsRef.current.pricePrecision,
      volumePrecision: propsRef.current.volumePrecision,
    });
    chart.setPeriod(toKLinePeriod(propsRef.current.timeframe));
    chart.setDataLoader(loader.loader);

    const onVisibleRangeChange = (_range?: unknown): void => {
      scheduleRefresh(chart);
    };
    const onCandleBarClick = (data: unknown): void => {
      const click = data as { kLineData?: KLineData; dataIndex?: number } | undefined;
      const bar = click?.kLineData ?? (typeof click?.dataIndex === 'number' ? chart.getDataList()[click.dataIndex] : undefined);
      if (!bar) return;
      const timeframeMs = timeframeToMs(propsRef.current.timeframe);
      const nearest = propsRef.current.events
        .map((event) => ({ event, distance: Math.abs(event.triggerAt - bar.timestamp) }))
        .filter((item) => item.distance <= timeframeMs * 2)
        .sort((a, b) => a.distance - b.distance)[0];
      if (nearest) propsRef.current.onEventSelect(nearest.event);
    };
    const onCrosshairChange = (data: unknown): void => {
      const crosshair = data as { kLineData?: KLineData; x?: number } | undefined;
      let bar = crosshair?.kLineData;
      if (!bar && typeof crosshair?.x === 'number') {
        const converted = chart.convertFromPixel(
          [{ x: crosshair.x }],
          { paneId: 'candle_pane' },
        ) as Array<{ dataIndex?: number }>;
        const index = converted[0]?.dataIndex;
        if (typeof index === 'number') {
          bar = chart.getDataList()[index];
        }
      }
      propsRef.current.onCrosshairChange(toReadout(bar));
    };
    chart.subscribeAction('onVisibleRangeChange', onVisibleRangeChange);
    chart.subscribeAction('onCrosshairChange', onCrosshairChange);
    chart.subscribeAction('onCandleBarClick', onCandleBarClick);
    const resize = new ResizeObserver(() => chart.resize());
    resize.observe(container);
    setReady(true);
    propsRef.current.onReady?.();
    return () => {
      resize.disconnect();
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
      if (profileTimerRef.current !== null) window.clearTimeout(profileTimerRef.current);
      chart.unsubscribeAction('onVisibleRangeChange', onVisibleRangeChange);
      chart.unsubscribeAction('onCrosshairChange', onCrosshairChange);
      chart.unsubscribeAction('onCandleBarClick', onCandleBarClick);
      loader.destroy();
      loaderRef.current = null;
      dispose(container);
      chartRef.current = null;
      setReady(false);
    };
  }, []);

  // Update data loader context first, then reset symbol/period.
  useEffect(() => {
    const chart = chartRef.current;
    const loader = loaderRef.current;
    if (!chart || !loader) return;
    loader.updateContext({
      symbol: props.symbol,
      timeframe: props.timeframe,
      onError: (error) => propsRef.current.onError(error),
      onStatus: (status) => propsRef.current.onChartStatus(status),
      onDataChange: () => {
        const last = chart.getDataList().at(-1);
        if (last) propsRef.current.onCrosshairChange(toReadout(last));
        scheduleRefresh(chart);
      },
    });
    chart.setSymbol({
      ticker: props.symbol,
      pricePrecision: props.pricePrecision,
      volumePrecision: props.volumePrecision,
    });
    chart.setPeriod(toKLinePeriod(props.timeframe));
  }, [props.symbol, props.timeframe, props.pricePrecision, props.volumePrecision]);

  // Recreate only project indicators. Never remove built-in/candle series.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready) return;
    for (const indicator of chart.getIndicators()) {
      if (indicator.name.startsWith('MS_')) chart.removeIndicator({ id: indicator.id });
    }
    const cfg = props.indicators;
    if (cfg.volume.enabled) {
      chart.createIndicator({
        name: INDICATOR_NAMES.volume,
        calcParams: [cfg.volume.maLength],
      });
    }
    if (cfg.kdj.enabled) {
      chart.createIndicator({
        name: INDICATOR_NAMES.kdj,
        calcParams: [cfg.kdj.length, cfg.kdj.kSmooth, cfg.kdj.dSmooth],
      });
    }
    if (cfg.rsi.enabled) {
      chart.createIndicator({
        name: INDICATOR_NAMES.rsi,
        calcParams: [cfg.rsi.length],
      });
    }
    if (cfg.macd.enabled) {
      chart.createIndicator({
        name: INDICATOR_NAMES.macd,
        calcParams: [cfg.macd.fast, cfg.macd.slow, cfg.macd.signal],
      });
    }
    if (cfg.boll.enabled) {
      chart.createIndicator({
        name: INDICATOR_NAMES.boll,
        calcParams: [cfg.boll.length, cfg.boll.mult],
        paneId: 'candle_pane',
      }, true);
    }
    if (cfg.ma.enabled) {
      const periods = [...cfg.ma.periods, 5, 10, 20, 60].slice(0, 4);
      chart.createIndicator({
        name: INDICATOR_NAMES.ma,
        calcParams: periods,
        paneId: 'candle_pane',
      }, true);
    }
  }, [ready, props.indicators]);

  // Volume Profile overlay lifecycle.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready) return;
    vpStateRef.current = { ...vpStateRef.current, settings: props.volumeProfile };
    const existing = chart.getOverlays({ name: VOLUME_PROFILE_OVERLAY })[0];
    if (!props.volumeProfile.enabled) {
      if (existing) chart.removeOverlay({ id: existing.id });
      return;
    }
    if (!existing) {
      const last = chart.getDataList().at(-1);
      chart.createOverlay({
        name: VOLUME_PROFILE_OVERLAY,
        paneId: 'candle_pane',
        lock: true,
        points: last ? [{ timestamp: last.timestamp, value: last.close }] : [],
        extendData: vpStateRef.current,
      });
    } else {
      forceVolumeProfileRedraw(chart, vpStateRef.current);
    }
    scheduleProfile(chart);
  }, [ready, props.volumeProfile]);

  // Rule event markers; group is replaced without touching user drawings.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready) return;
    chart.removeOverlay({ groupId: EVENT_GROUP });
    for (const event of props.events.slice(0, 120)) {
      chart.createOverlay({
        name: EVENT_MARKER_OVERLAY,
        paneId: 'candle_pane',
        groupId: EVENT_GROUP,
        lock: false,
        points: [{ timestamp: event.triggerAt, value: event.price }],
        extendData: event,
        onClick: () => propsRef.current.onEventSelect(event),
      });
    }
  }, [ready, props.events, props.symbol, props.timeframe]);

  // Restore drawings for the current symbol/timeframe. Do not persist the restore itself.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready) return;
    restoringDrawingsRef.current = true;
    chart.removeOverlay({ groupId: DRAWING_GROUP });
    for (const overlay of props.drawings) {
      if (!isDrawingTool(overlay.name)) continue;
      chart.createOverlay({
        name: overlay.name,
        paneId: 'candle_pane',
        groupId: DRAWING_GROUP,
        lock: overlay.lock ?? false,
        visible: overlay.visible ?? true,
        points: overlay.points,
        onDrawEnd: () => {
          window.setTimeout(() => persistDrawings(), 0);
        },
        onRemoved: () => {
          window.setTimeout(() => persistDrawings(), 0);
        },
      });
    }
    window.setTimeout(() => {
      restoringDrawingsRef.current = false;
    }, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, props.symbol, props.timeframe, props.drawings]);

  function persistDrawings(): void {
    const chart = chartRef.current;
    if (!chart || restoringDrawingsRef.current) return;
    const overlays = serializeUserOverlays(chart);
    propsRef.current.onDrawingsChange(overlays);
  }

  useImperativeHandle(ref, () => ({
    startDrawing: (tool) => {
      const chart = chartRef.current;
      if (!chart) return;
      chart.createOverlay({
        name: tool,
        paneId: 'candle_pane',
        groupId: DRAWING_GROUP,
        onDrawEnd: () => {
          window.setTimeout(() => {
            persistDrawings();
            propsRef.current.onDrawingDone?.();
          }, 0);
        },
        onRemoved: () => {
          window.setTimeout(() => persistDrawings(), 0);
        },
      });
    },
    clearDrawings: () => {
      const chart = chartRef.current;
      if (!chart) return;
      chart.removeOverlay({ groupId: DRAWING_GROUP });
      propsRef.current.onDrawingsChange([]);
    },
    scrollToLatest: () => chartRef.current?.scrollToRealTime(200),
    screenshot: () => chartRef.current?.getConvertPictureUrl(true, 'png', '#080d13') ?? null,
  }), [ready]);

  return <div ref={containerRef} className="chart-canvas" data-testid="chart-container" />;
});

function timeframeToMs(timeframe: string): number {
  if (timeframe === '1D') return 86_400_000;
  if (timeframe.endsWith('H')) return (Number(timeframe.slice(0, -1)) || 1) * 3_600_000;
  return (Number(timeframe.replace('m', '')) || 5) * 60_000;
}

export function toKLinePeriod(timeframe: string): { span: number; type: 'minute' | 'hour' | 'day' } {
  if (timeframe === '1D') return { span: 1, type: 'day' };
  if (timeframe.endsWith('H')) return { span: Number(timeframe.slice(0, -1)) || 1, type: 'hour' };
  return { span: Number(timeframe.replace('m', '')) || 5, type: 'minute' };
}
