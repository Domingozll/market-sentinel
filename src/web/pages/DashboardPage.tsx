import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  BarChart3,
  BellRing,
  Check,
  CircleAlert,
  Plus,
  Radio,
  RefreshCw,
  Settings2,
  TrendingUp,
} from 'lucide-react';
import type { Candle, EventView, RuleView } from '../../shared/types';
import { api } from '../api';
import { useAppData, useToast } from '../context';
import {
  aggregateTone,
  deliveryTone,
  DELIVERY_TEXT,
  formatCompact,
  formatDateTime,
  formatNumber,
  formatPrice,
  formatTime,
  TRIGGER_MODE_TEXT,
} from '../lib/format';
import { ErrorBanner, LoadingBlock, PageHeader, StatusPill } from '../components/ui';
import { MarketChart } from '../components/MarketChart';
import { ChartIndicatorPanel } from '../components/ChartIndicatorPanel';
import {
  chartIndicatorLegend,
  loadChartIndicatorSettings,
  saveChartIndicatorSettings,
  toggleChartIndicator,
  type ChartIndicatorKey,
  type ChartIndicatorSettings,
} from '../lib/chartIndicators';

const timeframes = ['1m', '5m', '15m', '1H', '4H'];

function statusDot(tone: string): string {
  switch (tone) {
    case 'success':
      return 'sdot ok';
    case 'warn':
      return 'sdot warn';
    case 'info':
      return 'sdot wait';
    case 'off':
      return 'sdot off';
    default:
      return 'sdot wait';
  }
}

export function DashboardPage() {
  const navigate = useNavigate();
  const { data, loading, error, refresh } = useAppData();
  const { showToast } = useToast();
  const [timeframe, setTimeframe] = useState('5m');
  const [candles, setCandles] = useState<Candle[]>([]);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);
  const [chartRefreshKey, setChartRefreshKey] = useState(0);
  const [chartSymbol, setChartSymbol] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [indicatorSettings, setIndicatorSettings] = useState<ChartIndicatorSettings>(() => loadChartIndicatorSettings());

  const applyIndicatorSettings = (next: ChartIndicatorSettings) => {
    setIndicatorSettings(next);
    saveChartIndicatorSettings(next);
  };
  const toggleIndicator = (key: ChartIndicatorKey) => {
    applyIndicatorSettings(toggleChartIndicator(indicatorSettings, key));
  };
  const indicatorLegend = useMemo(() => chartIndicatorLegend(indicatorSettings), [indicatorSettings]);

  const fallbackSymbol = data?.rules.find((rule) => rule.enabled && rule.symbols.length)?.symbols[0];
  const availableSymbols = useMemo(() => {
    const symbols = new Set<string>();
    data?.rules.forEach((rule) => rule.symbols.forEach((symbol) => symbols.add(symbol)));
    return [...symbols];
  }, [data]);
  const activeSymbol = chartSymbol && availableSymbols.includes(chartSymbol) ? chartSymbol : fallbackSymbol ?? availableSymbols[0] ?? 'BTC-USDT-SWAP';

  useEffect(() => {
    if (!chartSymbol && availableSymbols.length) setChartSymbol(availableSymbols[0]);
  }, [availableSymbols, chartSymbol]);

  const hasData = Boolean(data);
  useEffect(() => {
    if (!hasData) return;
    let cancelled = false;
    let timer: number | undefined;

    // Fetch on symbol/timeframe changes, then refresh on a slow cadence. Do not
    // refetch on every dashboard SSE tick: the candles endpoint may take ~500ms
    // and a fast live feed would otherwise cancel each request before it lands.
    setCandles([]);
    setChartLoading(true);
    setChartError(null);
    const load = () => {
      api
        .candles(activeSymbol, timeframe, 240)
        .then((response) => {
          if (cancelled) return;
          setCandles(response.candles);
          setChartError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setChartError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!cancelled) setChartLoading(false);
        });
    };
    load();
    timer = window.setInterval(load, 15_000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [activeSymbol, timeframe, hasData, chartRefreshKey]);

  const lastCandle = candles.at(-1);
  const previousCandle = candles.at(-2);
  const changePercent = lastCandle && previousCandle ? ((lastCandle.close / previousCandle.close - 1) * 100) : null;
  const lastTriggerEvents = data?.recentEvents ?? [];

  async function handleRefresh() {
    setRefreshing(true);
    await refresh();
    setChartRefreshKey((value) => value + 1);
    setRefreshing(false);
    showToast('已刷新当前状态', 'info');
  }

  if (loading && !data) {
    return (
      <div className="page-wrap">
        <LoadingBlock text="正在加载规则与行情状态…" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="page-wrap">
        <ErrorBanner message={error ?? '无法连接到本地监视服务'} onRetry={() => void refresh()} />
      </div>
    );
  }

  const stats = data.stats;
  const showOnboarding = data.rules.length === 0 || !data.settings.discordConfigured;
  const deliveryRate = stats.deliveryTotal > 0 ? Math.round((stats.deliverySuccess / stats.deliveryTotal) * 100) : null;

  return (
    <div className="page-wrap">
      {error ? <ErrorBanner message={error} onRetry={() => void refresh()} /> : null}
      <PageHeader
        eyebrow={<><span className="green-dot" /> 工作台</>}
        title="总览"
        subtitle={`${stats.activeRules} 条规则正在监控 · 数据时间 ${formatTime(data.status.exchangeNow)}`}
        actions={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => void handleRefresh()} disabled={refreshing}>
              <RefreshCw size={14} className={refreshing ? 'spin' : undefined} />
              刷新
            </button>
            <button type="button" className="btn btn-primary" onClick={() => navigate('/rules/new')}>
              <Plus size={14} />
              新建规则
            </button>
          </>
        }
      />

      {showOnboarding ? (
        <div className="onboarding">
          <div className="onboarding-left">
            <div className="onboarding-icon"><Radio size={15} /></div>
            <div>
              <div className="onboarding-title">完成 3 步即可开始监控</div>
              <div className="onboarding-text">
                行情连接、Discord 通知和第一条规则互相独立；未配置 Webhook 时事件仍会记录。
              </div>
              <div className="onboarding-steps" style={{ marginTop: 8 }}>
                <span className={`onboard-step${data.marketPairs.length ? ' done' : ''}`}>
                  {data.marketPairs.length ? <Check size={10} /> : <span className="warn-dot" />} 行情连接
                </span>
                <span className={`onboard-step${data.settings.discordConfigured ? ' done' : ''}`}>
                  {data.settings.discordConfigured ? <Check size={10} /> : <span className="warn-dot" />} 配置 Discord
                </span>
                <span className={`onboard-step${data.rules.length ? ' done' : ''}`}>
                  {data.rules.length ? <Check size={10} /> : <span className="warn-dot" />} 创建规则
                </span>
              </div>
            </div>
          </div>
          <div className="onboarding-actions">
            {!data.settings.discordConfigured ? (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => navigate('/settings')}>
                <Settings2 size={12} /> 配置 Discord
              </button>
            ) : null}
            <button type="button" className="btn btn-primary btn-sm" onClick={() => navigate('/rules/new')}>
              创建第一条规则
            </button>
          </div>
        </div>
      ) : null}

      <div className="cards-4">
        <div className="metric">
          <div className="metric-label"><span>监控中</span><span className="mini">ACTIVE</span></div>
          <div className="metric-value">{stats.activeRules}<small>/ {stats.totalRules} 条规则</small></div>
          <div className="metric-foot"><span className="green-dot" /> {stats.totalRules - stats.activeRules > 0 ? `${stats.totalRules - stats.activeRules} 条规则已暂停` : '全部规则已启用'}</div>
        </div>
        <div className="metric metric-link" onClick={() => navigate('/events')}>
          <div className="metric-label"><span>今日触发</span><span className="mini">TODAY</span></div>
          <div className="metric-value">{stats.todayEvents}<small>次</small></div>
          <div className="metric-foot"><BellRing size={11} /> 点击查看事件时间线</div>
        </div>
        <div className="metric metric-link" onClick={() => navigate('/events?status=failed')}>
          <div className="metric-label"><span>送达率</span><span className="mini">DISCORD</span></div>
          <div className="metric-value">{deliveryRate === null ? '—' : deliveryRate}<small>{deliveryRate === null ? '' : '%'}</small></div>
          <div className="metric-foot">
            {stats.deliveryTotal ? <><span className="green-dot" /> {stats.deliverySuccess} / {stats.deliveryTotal} 已送达</> : '尚无需要送达的事件'}
          </div>
        </div>
        <div className="metric">
          <div className="metric-label"><span>行情延迟</span><span className="mini">WS · {timeframe}</span></div>
          <div className="metric-value">{stats.marketLatencyMs === null ? '—' : Math.round(stats.marketLatencyMs)}<small>{stats.marketLatencyMs === null ? '' : 'ms'}</small></div>
          <div className="metric-foot"><span className={data.status.wsConnected ? 'green-dot' : 'warn-dot'} /> {data.status.wsConnected ? 'WebSocket 已连接' : '行情尚未连接'}</div>
        </div>
      </div>

      <div className="dashboard-grid">
        <section className="card">
          <div className="card-head">
            <div className="card-head-left">
              <div className="card-title">
                <h2>规则运行状态</h2>
                <div className="card-sub">每条规则按各自周期的最新数据独立判断</div>
              </div>
            </div>
            <button type="button" className="link" onClick={() => navigate('/rules')}>全部规则 →</button>
          </div>
          <div className="status-list">
            {data.rules.length === 0 ? (
              <div className="feed-empty">
                还没有规则。<button type="button" className="link-button" onClick={() => navigate('/rules/new')}>从模板创建第一条 →</button>
              </div>
            ) : data.rules.slice(0, 6).map((rule: RuleView) => {
              const tone = aggregateTone(rule.ruleStatus);
              return (
                <button key={rule.id} type="button" className="status-row" onClick={() => navigate(`/rules/${rule.id}/edit`)}>
                  <span className={statusDot(tone)} />
                  <div className="rule-info">
                    <div className="rule-name">
                      {rule.name}
                      {rule.symbols.slice(0, 2).map((symbol) => <span key={symbol} className="symbol-tag">{symbol}</span>)}
                    </div>
                    <div className="rule-summary dash-rule-summary">{rule.summary}</div>
                  </div>
                  <div className="row-side">
                    <StatusPill tone={tone}>{rule.statusLabel}</StatusPill>
                    <span className="row-time">{rule.lastTriggerAt ? formatTime(rule.lastTriggerAt) : '—'}</span>
                    <span className="chev" />
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div className="card-head-left">
              <div className="card-title">
                <h2>最近触发</h2>
                <div className="card-sub">发送状态与条件快照都可回溯</div>
              </div>
            </div>
            <button type="button" className="link" onClick={() => navigate('/events')}>全部 →</button>
          </div>
          <div className="feed">
            {lastTriggerEvents.length === 0 ? (
              <div className="feed-empty">还没有触发记录。规则进入监控后，条件成立会出现在这里。</div>
            ) : lastTriggerEvents.slice(0, 4).map((event: EventView) => (
              <div key={event.id} className="feed-item">
                <div className="feed-icon">{event.triggerMode === 'intrabar' ? <TrendingUp size={11} /> : <ArrowRight size={11} />}</div>
                <div className="feed-main">
                  <div className="feed-title">{event.ruleName} · {event.symbol}</div>
                  <div className="feed-sub">
                    {event.conditions.map((condition) => `${condition.timeframe} ${formatNumber(condition.leftValue)}`).join(' / ')}
                  </div>
                </div>
                <div className="feed-right">
                  <StatusPill tone={deliveryTone(event.delivery?.status)} noDot>{DELIVERY_TEXT[event.delivery?.status ?? 'skipped']}</StatusPill>
                  <span className="feed-time">{formatTime(event.triggerAt)}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="feed-link">
            <button type="button" onClick={() => navigate('/events')}>查看完整事件时间线 →</button>
            <span className="faint" style={{ fontSize: 9, fontFamily: 'var(--mono)' }}>{stats.todayEvents} TODAY</span>
          </div>
        </section>
      </div>

      <section className="card chart-card">
        <div className="chart-head-real">
          <div className="chart-symbol">
            <div className="symbol-orb">₿</div>
            <div>
              <div className="chart-title-row">
                <div className="chart-title">行情快照</div>
                <span className="symbol-tag">{activeSymbol}</span>
              </div>
              <div className="chart-sub-real">OKX · 公共行情 · {timeframe} · {data.status.wsConnected ? '实时' : '数据源未连接'}</div>
            </div>
            {lastCandle ? (
              <div className="chart-price">
                <strong>{formatPrice(lastCandle.close)}</strong>
                <span className={changePercent !== null && changePercent < 0 ? 'down' : 'up'}>
                  {changePercent === null ? '—' : `${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%`}
                </span>
              </div>
            ) : null}
          </div>
          <div className="chart-toolbar">
            {availableSymbols.length > 1 ? (
              <select className="selectish" style={{ height: 28 }} value={activeSymbol} onChange={(event) => setChartSymbol(event.target.value)}>
                {availableSymbols.map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}
              </select>
            ) : null}
            <div className="seg">
              {timeframes.map((tf) => (
                <button key={tf} type="button" className={tf === timeframe ? 'active' : ''} onClick={() => setTimeframe(tf)}>{tf}</button>
              ))}
            </div>
            <ChartIndicatorPanel settings={indicatorSettings} onChange={applyIndicatorSettings} />
          </div>
        </div>
        <div className="chart-legend-real">
          {indicatorLegend.map((item) => (
            <button
              key={item.key}
              type="button"
              className="chart-legend-chip"
              data-indicator={item.key}
              aria-pressed="true"
              title={`隐藏 ${item.label}`}
              onClick={() => toggleIndicator(item.key)}
            >
              <span className="legend-swatch" style={{ background: item.color }} />
              {item.label}
            </button>
          ))}
          <span className="legend-key"><span className="legend-swatch" style={{ background: '#31d7c2' }} />收盘价</span>
          <span className="legend-key"><span className="legend-swatch" style={{ background: '#efb45d' }} />规则触发</span>
          <span className="chart-hint">已收盘 K 线为主 · 点击图例隐藏指标 · 盘中模式展示形成中的 K 线</span>
        </div>
        {chartError ? (
          <div style={{ padding: '0 18px 10px' }}>
            <ErrorBanner message={chartError} onRetry={() => setChartRefreshKey((value) => value + 1)} />
          </div>
        ) : null}
        {chartLoading && candles.length === 0 ? (
          <LoadingBlock text="正在加载 K 线…" />
        ) : (
          <div style={{ padding: '0 8px 2px' }}>
            <MarketChart candles={candles} timeframe={timeframe} height={335} markers={[]} indicatorSettings={indicatorSettings} />
          </div>
        )}
        <div className="chart-foot-real">
          <div className="foot-stats">
            <span>O <b>{lastCandle ? formatPrice(lastCandle.open) : '—'}</b></span>
            <span>H <b>{lastCandle ? formatPrice(lastCandle.high) : '—'}</b></span>
            <span>L <b>{lastCandle ? formatPrice(lastCandle.low) : '—'}</b></span>
            <span>C <b>{lastCandle ? formatPrice(lastCandle.close) : '—'}</b></span>
            <span>VOL <b>{lastCandle ? formatCompact(lastCandle.volume) : '—'}</b></span>
          </div>
          <span style={{ color: '#7fcac0' }}>{data.settings.timezone} · {formatDateTime(data.status.exchangeNow, false, false)}</span>
        </div>
      </section>
      <div className="page-foot">
        <span>行情哨兵 · 只做提醒与记录，不自动下单</span>
        <span>OKX PUBLIC DATA · {data.status.wsConnected ? 'LIVE' : 'OFFLINE'}</span>
      </div>
    </div>
  );
}
