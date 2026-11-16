import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  Crosshair,
  Eye,
  EyeOff,
  Grip,
  Maximize2,
  Minimize2,
  PencilLine,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import type { Candle } from '../../../shared/types';
import { useToast } from '../../context';
import { formatCompact, formatDateTime, formatPrice } from '../../lib/format';
import { ProChart, type ProChartHandle } from './ProChart';
import { IndicatorPanel } from './IndicatorPanel';
import { VolumeProfilePanel } from './VolumeProfilePanel';
import { IndicatorLegend } from './IndicatorLegend';
import {
  loadWorkspace,
  saveWorkspace,
} from '../../lib/chart/indicatorSettings';
import {
  ALL_CHART_TIMEFRAMES,
  toDrawingKey,
  type ChartEventMarker,
  type ChartIndicatorConfig,
  type ChartIndicatorKey,
  type DrawingTool,
  type IndicatorLegendItem,
  type OhlcvReadout,
  type SerializedOverlay,
  type VolumeProfileSettings,
} from '../../lib/chart/types';
import type { VolumeProfileResult } from '../../lib/chart/volumeProfile';

const EMPTY_DRAWINGS: SerializedOverlay[] = [];
const DRAWING_TOOLS: Array<{ tool: DrawingTool; label: string }> = [
  { tool: 'segment', label: '趋势线' },
  { tool: 'horizontalStraightLine', label: '水平线' },
  { tool: 'rayLine', label: '射线' },
  { tool: 'priceChannelLine', label: '通道' },
  { tool: 'fibonacciLine', label: '斐波那契' },
  { tool: 'simpleAnnotation', label: '文字' },
  { tool: 'brush', label: '画笔' },
];

function statusLabel(status: 'connecting' | 'live' | 'polling' | 'offline' | 'static'): string {
  switch (status) {
    case 'live': return '实时连接';
    case 'polling': return '轮询模式';
    case 'connecting': return '连接中';
    case 'static': return '历史快照';
    default: return '已断开';
  }
}

export function ReplayProChart({
  symbol,
  timeframe,
  pricePrecision = 2,
  volumePrecision = 0,
  candles,
  events,
  onEventSelect,
  focusTimestamp,
  onTimeframeChange,
  timeframeLoading = false,
}: {
  symbol: string;
  timeframe: string;
  pricePrecision?: number;
  volumePrecision?: number;
  candles: Candle[];
  events: ChartEventMarker[];
  onEventSelect?: (event: ChartEventMarker) => void;
  focusTimestamp?: number | null;
  onTimeframeChange?: (timeframe: string) => void;
  timeframeLoading?: boolean;
}) {
  const { showToast } = useToast();
  const [workspace, setWorkspace] = useState(() => loadWorkspace());
  const [readout, setReadout] = useState<OhlcvReadout>({
    timestamp: null, open: null, high: null, low: null, close: null, volume: null,
  });
  const [legendItems, setLegendItems] = useState<IndicatorLegendItem[]>([]);
  const [profile, setProfile] = useState<VolumeProfileResult | null>(null);
  const [chartStatus, setChartStatus] = useState<'connecting' | 'live' | 'polling' | 'offline' | 'static'>('static');
  const [chartError, setChartError] = useState<string | null>(null);
  const [panel, setPanel] = useState<'indicator' | 'volume' | null>(null);
  const [drawingOpen, setDrawingOpen] = useState(false);
  const [activeTool, setActiveTool] = useState<DrawingTool | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [hovered, setHovered] = useState<{ event: ChartEventMarker; x: number; y: number } | null>(null);
  const chartRef = useRef<ProChartHandle | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;

  const drawingKey = toDrawingKey(symbol, timeframe);
  const drawings = useMemo(() => workspace.drawings[drawingKey] ?? EMPTY_DRAWINGS, [workspace.drawings, drawingKey]);
  const profileLegend = useMemo(() => {
    if (!workspace.volumeProfile.enabled) return null;
    if (!profile) return '计算中…';
    if (profile.totalVolume <= 0 || profile.poc === null) return '当前范围无有效成交量';
    const va = profile.valueLow !== null && profile.valueHigh !== null
      ? ` · VA ${formatPrice(profile.valueLow)}–${formatPrice(profile.valueHigh)}`
      : '';
    return `POC ${formatPrice(profile.poc)}${va} · ${profile.bins.length} 档`;
  }, [profile, workspace.volumeProfile.enabled]);
  const readoutTime = readout.timestamp ? formatDateTime(readout.timestamp, false, false) : '—';
  const activeToolLabel = DRAWING_TOOLS.find((item) => item.tool === activeTool)?.label;

  useEffect(() => {
    saveWorkspace(workspace);
  }, [workspace]);

  useEffect(() => {
    if (focusTimestamp === null || focusTimestamp === undefined) return;
    chartRef.current?.scrollToTimestamp(focusTimestamp);
  }, [focusTimestamp]);

  useEffect(() => {
    document.body.style.overflow = focusMode ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [focusMode]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && focusMode && !document.fullscreenElement) setFocusMode(false);
    };
    const onFullscreen = () => {
      if (!document.fullscreenElement) setFocusMode(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFullscreen);
    };
  }, [focusMode]);

  function updateWorkspace(next: typeof workspace) {
    workspaceRef.current = next;
    setWorkspace(next);
  }

  function updateIndicators(next: ChartIndicatorConfig) {
    updateWorkspace({ ...workspaceRef.current, indicators: next });
  }

  function updateVolumeProfile(next: VolumeProfileSettings) {
    updateWorkspace({ ...workspaceRef.current, volumeProfile: next });
  }

  function setIndicatorVisible(key: ChartIndicatorKey, visible: boolean) {
    const current = workspaceRef.current;
    updateWorkspace({
      ...current,
      indicators: { ...current.indicators, [key]: { ...current.indicators[key], visible } },
    });
    setLegendItems((items) => items.map((item) => (item.key === key ? { ...item, visible } : item)));
  }

  function closeIndicator(key: ChartIndicatorKey) {
    const current = workspaceRef.current;
    updateWorkspace({
      ...current,
      indicators: { ...current.indicators, [key]: { ...current.indicators[key], enabled: false, visible: false } },
    });
    setLegendItems((items) => items.filter((item) => item.key !== key));
  }

  function updateDrawings(next: SerializedOverlay[]) {
    const current = workspaceRef.current;
    const map = { ...current.drawings };
    if (next.length) map[drawingKey] = next;
    else delete map[drawingKey];
    updateWorkspace({ ...current, drawings: map });
  }

  function handleTool(tool: DrawingTool) {
    setActiveTool(tool);
    chartRef.current?.startDrawing(tool);
  }

  async function toggleFullscreen() {
    if (!focusMode) {
      setFocusMode(true);
      try {
        await pageRef.current?.requestFullscreen?.();
      } catch {
        // CSS focus mode is the fallback when native fullscreen is unavailable.
      }
    } else {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
      setFocusMode(false);
      setActiveTool(null);
    }
  }

  function takeScreenshot() {
    const dataUrl = chartRef.current?.screenshot();
    if (!dataUrl) {
      showToast('图表尚未准备好', 'error');
      return;
    }
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = `market-sentinel-replay-${symbol}-${timeframe}-${Date.now()}.png`;
    link.click();
  }

  return (
    <div
      ref={pageRef}
      className={`replay-chart-workbench${focusMode ? ' focus-mode' : ''}`}
      data-testid="replay-pro-chart"
      data-fullscreen={focusMode ? 'true' : 'false'}
    >
      <div className="chart-toolbar replay-chart-toolbar">
        <div className="chart-timeframes replay-chart-timeframes" data-testid="replay-timeframes">
          {ALL_CHART_TIMEFRAMES.map((item) => (
            <button
              type="button"
              key={item}
              className={item === timeframe ? 'active' : ''}
              data-testid={`replay-timeframe-${item}`}
              onClick={() => onTimeframeChange?.(item)}
              disabled={timeframeLoading}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="chart-toolbar-actions">
          {timeframeLoading ? <span className="replay-timeframe-loading"><span className="chart-live-dot connecting" /> 切换周期…</span> : null}
          <button type="button" className={`chart-tool${panel === 'indicator' ? ' active' : ''}`} data-testid="replay-chart-indicators" onClick={() => setPanel(panel === 'indicator' ? null : 'indicator')}>
            <SlidersHorizontal size={13} /> 指标
          </button>
          <button type="button" className={`chart-tool${panel === 'volume' ? ' active' : ''}`} data-testid="replay-chart-volume" onClick={() => setPanel(panel === 'volume' ? null : 'volume')}>
            <Grip size={13} /> VP
          </button>
          <button type="button" className={`chart-tool${drawingOpen ? ' active' : ''}`} data-testid="replay-chart-drawing" onClick={() => { setDrawingOpen((value) => !value); setActiveTool(null); }}>
            <PencilLine size={13} /> 画线
          </button>
          <button type="button" className="chart-tool" onClick={() => chartRef.current?.clearDrawings()} title="清空画线">
            <X size={13} /> 清空
          </button>
          <button type="button" className="chart-tool" onClick={() => chartRef.current?.scrollToLatest()} title="回到最新K线">
            <Crosshair size={13} /> 最新
          </button>
          <button type="button" className="chart-tool" onClick={takeScreenshot} title="保存图表截图">
            <Camera size={13} /> 截图
          </button>
          <button type="button" className="chart-tool" onClick={() => void toggleFullscreen()} aria-pressed={focusMode} title="全屏查看">
            {focusMode ? <Minimize2 size={13} /> : <Maximize2 size={13} />} {focusMode ? '退出' : '全屏'}
          </button>
        </div>
      </div>

      {drawingOpen ? (
        <div className="chart-drawing-bar" data-testid="replay-chart-drawing-bar">
          <span className="chart-bar-label">画线工具</span>
          {DRAWING_TOOLS.map(({ tool, label }) => (
            <button
              type="button"
              key={tool}
              className={`chart-drawing-tool${activeTool === tool ? ' active' : ''}`}
              data-testid={`replay-chart-drawing-${tool}`}
              onClick={() => handleTool(tool)}
            >
              {label}
            </button>
          ))}
          {activeTool ? <span className="chart-bar-hint">正在绘制：{activeToolLabel} · ESC 取消</span> : null}
        </div>
      ) : null}

      {panel === 'indicator' ? (
        <IndicatorPanel config={workspace.indicators} onChange={updateIndicators} onClose={() => setPanel(null)} />
      ) : null}
      {panel === 'volume' ? (
        <VolumeProfilePanel settings={workspace.volumeProfile} onChange={updateVolumeProfile} onClose={() => setPanel(null)} />
      ) : null}

      <div ref={stageRef} className="chart-stage replay-chart-stage" data-testid="replay-pro-stage">
        <ProChart
          ref={chartRef}
          symbol={symbol}
          timeframe={timeframe}
          pricePrecision={pricePrecision}
          volumePrecision={volumePrecision}
          indicators={workspace.indicators}
          volumeProfile={workspace.volumeProfile}
          drawings={drawings}
          events={events}
          eventMarkerLimit={500}
          staticCandles={candles}
          onDrawingsChange={updateDrawings}
          onDrawingDone={() => setActiveTool(null)}
          onEventSelect={(event) => {
            setHovered(null);
            onEventSelect?.(event);
          }}
          onEventHover={(event, position) => setHovered({ event, x: position.x, y: position.y })}
          onEventLeave={() => setHovered(null)}
          onCrosshairChange={setReadout}
          onIndicatorLegend={setLegendItems}
          onVisibleProfile={setProfile}
          onChartStatus={setChartStatus}
          onError={(error) => {
            setChartStatus('offline');
            setChartError(error instanceof Error ? error.message : String(error));
          }}
        />
        <div className="chart-overlay-top">
          <div className="chart-overlay-left">
            <div className="chart-ohlc-readout" data-testid="replay-chart-ohlc">
              <span><em>O</em><b>{readout.open === null ? '—' : formatPrice(readout.open)}</b></span>
              <span><em>H</em><b>{readout.high === null ? '—' : formatPrice(readout.high)}</b></span>
              <span><em>L</em><b>{readout.low === null ? '—' : formatPrice(readout.low)}</b></span>
              <span><em>C</em><b className={readout.close !== null && readout.open !== null && readout.close < readout.open ? 'down' : 'up'}>{readout.close === null ? '—' : formatPrice(readout.close)}</b></span>
              <span><em>VOL</em><b>{readout.volume === null ? '—' : formatCompact(readout.volume)}</b></span>
              <span className="chart-readout-time">{readoutTime}</span>
            </div>
            <IndicatorLegend
              items={legendItems}
              onEdit={() => setPanel('indicator')}
              onToggleVisible={(key) => setIndicatorVisible(key, !workspaceRef.current.indicators[key].visible)}
              onClose={closeIndicator}
            />
          </div>
          <div className="chart-vp-wrap">
            {workspace.volumeProfile.enabled ? (
              <div className="chart-profile-legend" data-testid="replay-chart-vp-legend">
                <button type="button" className="chart-vp-main" onClick={() => setPanel('volume')} title="打开 Volume Profile 设置">VP</button>
                <span className="chart-vp-value">{profileLegend}</span>
                <button
                  type="button"
                  className="chart-vp-eye"
                  aria-label="隐藏 Volume Profile"
                  onClick={() => updateVolumeProfile({ ...workspace.volumeProfile, enabled: false })}
                >
                  <Eye size={11} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="chart-vp-restore"
                onClick={() => updateVolumeProfile({ ...workspace.volumeProfile, enabled: true })}
              >
                <EyeOff size={11} /> VP 已隐藏
              </button>
            )}
          </div>
        </div>
        {chartError ? <div className="chart-error-toast" role="alert">{chartError}</div> : null}
        {hovered ? (
          <div
            className="replay-signal-tooltip"
            data-testid="replay-signal-tooltip"
            style={(() => {
              const stageWidth = stageRef.current?.clientWidth ?? 800;
              const stageHeight = stageRef.current?.clientHeight ?? 520;
              const stageTop = stageRef.current?.getBoundingClientRect().top ?? 0;
              const tooltipHeight = 176;
              let top = hovered.y + 14;
              if (stageTop + top + tooltipHeight > window.innerHeight - 12) {
                top = hovered.y - tooltipHeight - 14;
              }
              return {
                left: Math.max(8, Math.min(hovered.x + 14, stageWidth - 292)),
                top: Math.max(8, Math.min(top, stageHeight - tooltipHeight - 8)),
              };
            })()}
          >
            <div className="rst-head">
              <span className="rst-badge">{hovered.event.label || (hovered.event.triggerMode === 'intrabar' ? '盘中信号' : '通知信号')}</span>
              <span className="rst-mode">{hovered.event.triggerMode === 'intrabar' ? '盘中触发' : '收盘确认'}</span>
            </div>
            <div className="rst-rule">{hovered.event.ruleName}</div>
            <div className="rst-grid">
              <span>时间</span><b>{formatDateTime(hovered.event.triggerAt, false, false)}</b>
              <span>触发价</span><b>{formatPrice(hovered.event.price)}</b>
              <span>品种</span><b>{hovered.event.symbol}</b>
            </div>
            {hovered.event.note ? <div className="rst-note">{hovered.event.note}</div> : null}
            <div className="rst-foot">历史模拟信号 · 点击标记定位下方清单</div>
          </div>
        ) : null}
      </div>
      <div className="chart-statusbar">
        <span className={`chart-live-dot ${chartStatus}`} />
        <span>{statusLabel(chartStatus)}</span>
        <span>{symbol} · {timeframe}</span>
        <span>{Object.values(workspace.indicators).filter((item) => item.visible).length + 1} 个图层</span>
        <span className="chart-status-spacer" />
        <span>历史已收盘 K 线 · 共 {candles.length} 根</span>
      </div>
    </div>
  );
}
