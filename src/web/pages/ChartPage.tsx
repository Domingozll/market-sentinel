import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Camera,
  Crosshair,
  Grip,
  Maximize2,
  Minimize2,
  PencilLine,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import type { InstrumentInfo } from '../api';
import { api } from '../api';
import { useAppData, useToast } from '../context';
import {
  formatCompact,
  formatDateTime,
  formatPrice,
} from '../lib/format';
import { ProChart, type ProChartHandle } from '../components/chart/ProChart';
import { IndicatorPanel } from '../components/chart/IndicatorPanel';
import { VolumeProfilePanel } from '../components/chart/VolumeProfilePanel';
import { ChartEventPopover } from '../components/chart/ChartEventPopover';
import {
  ALL_CHART_TIMEFRAMES,
  toDrawingKey,
  type ChartEventMarker,
  type ChartIndicatorConfig,
  type DrawingTool,
  type SerializedOverlay,
  type VolumeProfileSettings,
} from '../lib/chart/types';
import {
  loadWorkspace,
  saveWorkspace,
} from '../lib/chart/indicatorSettings';
import type { VolumeProfileResult } from '../lib/chart/volumeProfile';

const EMPTY_DRAWINGS: SerializedOverlay[] = [];
const VALID_TIMEFRAMES = new Set(ALL_CHART_TIMEFRAMES);

const DRAWING_TOOLS: Array<{ tool: DrawingTool; label: string }> = [
  { tool: 'segment', label: '趋势线' },
  { tool: 'horizontalStraightLine', label: '水平线' },
  { tool: 'rayLine', label: '射线' },
  { tool: 'priceChannelLine', label: '通道' },
  { tool: 'fibonacciLine', label: '斐波那契' },
  { tool: 'simpleAnnotation', label: '文字' },
  { tool: 'brush', label: '画笔' },
];

function validSymbol(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9-]{3,40}$/.test(normalized) ? normalized : null;
}

function decimalPlaces(value: string | undefined): number | null {
  if (!value) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const text = value.toLowerCase();
  if (text.includes('e-')) return Number(text.split('e-')[1]) || null;
  const decimal = text.split('.')[1];
  return decimal ? decimal.length : 0;
}

function precisionFromInstrument(instrument: InstrumentInfo | null): { price: number; volume: number } {
  return {
    price: decimalPlaces(instrument?.tickSz) ?? 2,
    volume: decimalPlaces(instrument?.lotSz) ?? 0,
  };
}

function markerFromEvent(event: {
  id: string;
  ruleId: string | null;
  ruleName: string;
  symbol: string;
  triggerAt: number;
  price: number;
  triggerMode: 'close' | 'intrabar';
  note: string;
  delivery: { status: string } | null;
}): ChartEventMarker {
  return {
    id: event.id,
    ruleId: event.ruleId,
    ruleName: event.ruleName,
    symbol: event.symbol,
    triggerAt: event.triggerAt,
    price: event.price,
    triggerMode: event.triggerMode,
    note: event.note,
    deliveryStatus: event.delivery?.status ?? null,
  };
}

function statusLabel(status: 'connecting' | 'live' | 'polling' | 'offline'): string {
  switch (status) {
    case 'live': return '实时连接';
    case 'polling': return '轮询模式';
    case 'connecting': return '连接中';
    default: return '已断开';
  }
}

export function ChartPage() {
  const navigate = useNavigate();
  const { data } = useAppData();
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlSymbol = validSymbol(searchParams.get('symbol'));
  const urlTimeframe = searchParams.get('timeframe');
  const initialTimeframe = urlTimeframe && VALID_TIMEFRAMES.has(urlTimeframe as never) ? urlTimeframe : '5m';
  const [symbol, setSymbol] = useState(urlSymbol ?? 'BTC-USDT-SWAP');
  const [timeframe, setTimeframe] = useState(initialTimeframe);
  const [workspace, setWorkspace] = useState(() => loadWorkspace());
  const [instrument, setInstrument] = useState<InstrumentInfo | null>(null);
  const [symbolQuery, setSymbolQuery] = useState(symbol);
  const [symbolResults, setSymbolResults] = useState<InstrumentInfo[]>([]);
  const [symbolOpen, setSymbolOpen] = useState(false);
  const [events, setEvents] = useState<ChartEventMarker[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<ChartEventMarker | null>(null);
  const [eventPanelOpen, setEventPanelOpen] = useState(false);
  const [readout, setReadout] = useState({ timestamp: null as number | null, open: null as number | null, high: null as number | null, low: null as number | null, close: null as number | null, volume: null as number | null });
  const [profile, setProfile] = useState<VolumeProfileResult | null>(null);
  const [chartStatus, setChartStatus] = useState<'connecting' | 'live' | 'polling' | 'offline'>('connecting');
  const [chartError, setChartError] = useState<string | null>(null);
  const [panel, setPanel] = useState<'indicator' | 'volume' | null>(null);
  const [drawingOpen, setDrawingOpen] = useState(false);
  const [activeTool, setActiveTool] = useState<DrawingTool | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [bootstrapped, setBootstrapped] = useState(Boolean(urlSymbol));
  const chartRef = useRef<ProChartHandle | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;

  const precision = useMemo(() => precisionFromInstrument(instrument), [instrument]);
  const drawingKey = toDrawingKey(symbol, timeframe);
  const drawings = useMemo(() => workspace.drawings[drawingKey] ?? EMPTY_DRAWINGS, [workspace.drawings, drawingKey]);
  const profileLegend = useMemo(() => {
    if (!profile || profile.poc === null) return null;
    const va = profile.valueLow !== null && profile.valueHigh !== null
      ? ` · VA ${formatPrice(profile.valueLow)}–${formatPrice(profile.valueHigh)}`
      : '';
    return `POC ${formatPrice(profile.poc)}${va}`;
  }, [profile]);

  const defaultRuleSymbol = data?.rules.find((rule) => rule.enabled && rule.symbols.length)?.symbols[0];
  useEffect(() => {
    if (bootstrapped || urlSymbol || !defaultRuleSymbol) return;
    setBootstrapped(true);
    setSymbol(defaultRuleSymbol);
    setSymbolQuery(defaultRuleSymbol);
  }, [bootstrapped, urlSymbol, defaultRuleSymbol]);

  useEffect(() => {
    const next = new URLSearchParams();
    next.set('symbol', symbol);
    next.set('timeframe', timeframe);
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, symbol, timeframe]);

  useEffect(() => {
    saveWorkspace(workspace);
  }, [workspace]);

  useEffect(() => {
    let cancelled = false;
    setChartError(null);
    api.instruments(symbol)
      .then(({ instruments }) => {
        if (cancelled) return;
        const exact = instruments.find((item) => item.instId === symbol) ?? null;
        setInstrument(exact);
      })
      .catch(() => {
        if (!cancelled) setInstrument(null);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  useEffect(() => {
    const query = symbolQuery.trim().toUpperCase();
    if (!query || query === symbol) {
      setSymbolResults([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api.instruments(query)
        .then(({ instruments }) => {
          if (!cancelled) setSymbolResults(instruments.filter((item) => item.instId !== symbol).slice(0, 12));
        })
        .catch(() => {
          if (!cancelled) setSymbolResults([]);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [symbolQuery, symbol]);

  useEffect(() => {
    let cancelled = false;
    api.events({ symbol, limit: 200 })
      .then(({ events: rows }) => {
        if (!cancelled) setEvents(rows.map(markerFromEvent));
      })
      .catch(() => {
        if (!cancelled) setEvents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, data?.recentEvents]);

  useEffect(() => {
    document.body.style.overflow = focusMode ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [focusMode]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && focusMode && !document.fullscreenElement) {
        setFocusMode(false);
        setActiveTool(null);
      }
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

  function updateDrawings(next: SerializedOverlay[]) {
    const current = workspaceRef.current;
    const drawingsMap = { ...current.drawings };
    if (next.length) drawingsMap[drawingKey] = next;
    else delete drawingsMap[drawingKey];
    updateWorkspace({ ...current, drawings: drawingsMap });
  }

  function selectInstrument(value: InstrumentInfo) {
    setSymbol(value.instId);
    setInstrument(value);
    setSymbolQuery(value.instId);
    setSymbolOpen(false);
    setSymbolResults([]);
  }

  function submitSymbol() {
    const query = symbolQuery.trim().toUpperCase();
    if (!validSymbol(query)) {
      showToast('请输入合法的 OKX 品种，例如 BTC-USDT-SWAP', 'error');
      return;
    }
    const match = symbolResults.find((item) => item.instId === query) ?? symbolResults[0];
    if (match) selectInstrument(match);
    else {
      setSymbol(query);
      setSymbolOpen(false);
    }
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
        // iPhone Safari and some embedded browsers disallow element fullscreen;
        // the CSS focus mode below is the intentional fallback.
      }
    } else {
      if (document.fullscreenElement) {
        await document.exitFullscreen().catch(() => undefined);
      }
      setFocusMode(false);
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
    link.download = `market-sentinel-${symbol}-${timeframe}-${Date.now()}.png`;
    link.click();
  }

  const readoutTime = readout.timestamp ? formatDateTime(readout.timestamp, false, false) : '—';
  const activeToolLabel = DRAWING_TOOLS.find((item) => item.tool === activeTool)?.label;

  return (
    <div
      ref={pageRef}
      className={`chart-page${focusMode ? ' focus-mode' : ''}`}
      data-testid="chart-workspace"
      data-fullscreen={focusMode ? 'true' : 'false'}
    >
      <div className="chart-page-head">
        <div>
          <div className="eyebrow">专业图表</div>
          <div className="chart-symbol-line">
            <div className="chart-symbol-search-wrap">
              <Search size={14} />
              <input
                className="chart-symbol-search"
                data-testid="chart-symbol-search"
                value={symbolQuery}
                aria-label="搜索品种"
                onChange={(event) => {
                  setSymbolQuery(event.target.value);
                  setSymbolOpen(true);
                }}
                onFocus={() => setSymbolOpen(true)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') submitSymbol();
                  if (event.key === 'Escape') setSymbolOpen(false);
                }}
              />
              {symbolOpen && symbolResults.length ? (
                <div className="chart-symbol-results">
                  {symbolResults.map((item) => (
                    <button type="button" key={item.instId} onClick={() => selectInstrument(item)}>
                      <span>{item.instId}</span>
                      <small>{item.instType}</small>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <span className="chart-current-symbol" data-testid="chart-symbol-current">{symbol}</span>
            <span className="chart-period-badge">{timeframe}</span>
          </div>
        </div>
        <div className="chart-actions">
          <button type="button" className="btn btn-secondary btn-sm" data-testid="chart-screenshot" onClick={takeScreenshot}>
            <Camera size={13} /> 截图
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            data-testid="chart-fullscreen"
            onClick={() => void toggleFullscreen()}
            aria-pressed={focusMode}
          >
            {focusMode ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            {focusMode ? '退出全屏' : '全屏'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => chartRef.current?.scrollToLatest()}>
            <Crosshair size={13} /> 最新
          </button>
        </div>
      </div>

      <div className="chart-toolbar">
        <div className="chart-timeframes" data-testid="chart-timeframe">
          {ALL_CHART_TIMEFRAMES.map((item) => (
            <button
              type="button"
              key={item}
              className={item === timeframe ? 'active' : ''}
              onClick={() => setTimeframe(item)}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="chart-toolbar-actions">
          <button type="button" className={`chart-tool${panel === 'indicator' ? ' active' : ''}`} data-testid="chart-indicators-button" onClick={() => setPanel(panel === 'indicator' ? null : 'indicator')}>
            <SlidersHorizontal size={13} /> 指标
          </button>
          <button type="button" className={`chart-tool${panel === 'volume' ? ' active' : ''}`} data-testid="chart-volume-profile-toggle" onClick={() => setPanel(panel === 'volume' ? null : 'volume')}>
            <Grip size={13} /> VP
          </button>
          <button type="button" className={`chart-tool${drawingOpen ? ' active' : ''}`} data-testid="chart-drawing-button" onClick={() => { setDrawingOpen((value) => !value); setActiveTool(null); }}>
            <PencilLine size={13} /> 画线
          </button>
          <button type="button" className="chart-tool" onClick={() => chartRef.current?.clearDrawings()} title="清空画线">
            <X size={13} /> 清空
          </button>
          {events.length ? (
            <button
              type="button"
              className={`chart-tool${eventPanelOpen ? ' active' : ''}`}
              data-testid="chart-event-list-toggle"
              onClick={() => setEventPanelOpen((value) => !value)}
            >
              触发 {events.length}
            </button>
          ) : null}
        </div>
      </div>

      {drawingOpen ? (
        <div className="chart-drawing-bar" data-testid="chart-drawing-bar">
          <span className="chart-bar-label">画线工具</span>
          {DRAWING_TOOLS.map(({ tool, label }) => (
            <button
              type="button"
              key={tool}
              className={`chart-drawing-tool${activeTool === tool ? ' active' : ''}`}
              data-testid={`chart-drawing-${tool}`}
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
      {eventPanelOpen ? (
        <div className="chart-event-list" data-testid="chart-event-list">
          <div className="chart-popover-head">
            <div>
              <div className="chart-popover-title">最近规则触发</div>
              <div className="chart-popover-sub">点击查看事件详情；画布标记也可点击</div>
            </div>
            <button type="button" className="chart-popover-close" onClick={() => setEventPanelOpen(false)} aria-label="关闭事件列表">×</button>
          </div>
          <div className="chart-event-list-body">
            {events.slice(0, 12).map((event) => (
              <button
                type="button"
                key={event.id}
                className="chart-event-list-row"
                onClick={() => {
                  setSelectedEvent(event);
                  setEventPanelOpen(false);
                }}
              >
                <span>{event.ruleName}</span>
                <small>{formatDateTime(event.triggerAt, false, false)} · {formatPrice(event.price)}</small>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="chart-stage">
        <ProChart
          ref={chartRef}
          symbol={symbol}
          timeframe={timeframe}
          pricePrecision={precision.price}
          volumePrecision={precision.volume}
          indicators={workspace.indicators}
          volumeProfile={workspace.volumeProfile}
          drawings={drawings}
          events={events}
          onDrawingsChange={updateDrawings}
          onDrawingDone={() => setActiveTool(null)}
          onEventSelect={setSelectedEvent}
          onCrosshairChange={setReadout}
          onVisibleProfile={setProfile}
          onChartStatus={setChartStatus}
          onError={(error) => {
            setChartStatus('offline');
            setChartError(error instanceof Error ? error.message : String(error));
          }}
        />
        <div className="chart-overlay-top">
          <div className="chart-ohlc-readout" data-testid="chart-ohlc-readout">
            <span><em>O</em><b>{readout.open === null ? '—' : formatPrice(readout.open)}</b></span>
            <span><em>H</em><b>{readout.high === null ? '—' : formatPrice(readout.high)}</b></span>
            <span><em>L</em><b>{readout.low === null ? '—' : formatPrice(readout.low)}</b></span>
            <span><em>C</em><b className={readout.close !== null && readout.open !== null && readout.close < readout.open ? 'down' : 'up'}>{readout.close === null ? '—' : formatPrice(readout.close)}</b></span>
            <span><em>VOL</em><b>{readout.volume === null ? '—' : formatCompact(readout.volume)}</b></span>
            <span className="chart-readout-time">{readoutTime}</span>
          </div>
          {workspace.volumeProfile.enabled && profileLegend ? (
            <div className="chart-profile-legend" data-testid="chart-volume-profile-legend">{profileLegend}</div>
          ) : null}
        </div>
        {chartError ? (
          <div className="chart-error-toast" role="alert">{chartError}</div>
        ) : null}
        {selectedEvent ? (
          <ChartEventPopover
            event={selectedEvent}
            onClose={() => setSelectedEvent(null)}
            onOpenEvents={() => navigate('/events')}
          />
        ) : null}
      </div>

      <div className="chart-statusbar" data-testid="chart-status">
        <span className={`chart-live-dot ${chartStatus}`} />
        <span>{statusLabel(chartStatus)}</span>
        <span>{instrument?.instType ?? 'OKX'} · {symbol}</span>
        <span>{timeframe} · {data?.settings.timezone ?? 'Asia/Shanghai'}</span>
        <span className="chart-status-spacer" />
        <span>数据源 OKX 公共行情</span>
        <span>缩放/拖拽查看历史 · 向左拖动加载更多</span>
      </div>
    </div>
  );
}
