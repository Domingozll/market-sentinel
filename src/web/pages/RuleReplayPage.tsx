import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Copy, Loader2, PenLine, PlayCircle, RotateCcw, TriangleAlert } from 'lucide-react';
import {
  COMPARATOR_LABEL,
  SERIES_CATALOG,
  type Candle,
  type ConditionEvaluation,
  type ReplayRecord,
  type ReplaySummary,
  type RuleView,
  type Timeframe,
  type TrialResult,
  type TrialTrigger,
} from '../../shared/types';
import { api } from '../api';
import { useToast } from '../context';
import {
  formatDateTime,
  formatNumber,
  TRIGGER_MODE_TEXT,
} from '../lib/format';
import { ErrorBanner, LoadingBlock, PageHeader } from '../components/ui';
import { ReplayProChart } from '../components/chart/ReplayProChart';
import type { ChartEventMarker } from '../lib/chart/types';

const WINDOWS = [7, 14, 30] as const;

function conditionText(condition: ConditionEvaluation): string {
  const right = condition.rightSeries
    ? SERIES_CATALOG[condition.rightSeries].label
    : formatNumber(condition.rightValue);
  return `${condition.timeframe} ${SERIES_CATALOG[condition.leftSeries].label} ${COMPARATOR_LABEL[condition.cmp]} ${right}`;
}

function triggerModeText(trigger: TrialTrigger): string {
  return trigger.triggerMode === 'intrabar' ? '盘中触发（历史按收盘模拟）' : TRIGGER_MODE_TEXT[trigger.triggerMode];
}

export function RuleReplayPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [rule, setRule] = useState<RuleView | null>(null);
  const [loadingRule, setLoadingRule] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [symbol, setSymbol] = useState('');
  const [windowDays, setWindowDays] = useState(7);
  const [chartTimeframe, setChartTimeframe] = useState<Timeframe>('5m');
  const [viewCandles, setViewCandles] = useState<Candle[]>([]);
  const [chartLoading, setChartLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [loadingSaved, setLoadingSaved] = useState(false);
  const [result, setResult] = useState<TrialResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [selectedTrigger, setSelectedTrigger] = useState<number | null>(null);
  const [focusTimestamp, setFocusTimestamp] = useState<number | null>(null);
  const [replays, setReplays] = useState<ReplaySummary[]>([]);
  const [selectedReplayId, setSelectedReplayId] = useState('');
  const [savedMeta, setSavedMeta] = useState<{ createdAt: number; ruleVersion: number } | null>(null);
  const [ruleUpdated, setRuleUpdated] = useState(false);
  const requestSeq = useRef(0);

  function candlesFromResult(next: TrialResult): Candle[] {
    return next.candles.map((candle) => ({
      instId: next.symbol,
      timeframe: next.timeframe,
      openTime: candle.openTime,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      vol: 0,
      volCcy: 0,
      volCcyQuote: candle.volume,
      confirm: true,
    }));
  }

  function applyReplay(replay: ReplayRecord) {
    setResult(replay.result);
    setViewCandles(candlesFromResult(replay.result));
    setSymbol(replay.symbol);
    setWindowDays(replay.windowDays);
    setChartTimeframe(replay.chartTimeframe);
    setSelectedReplayId(replay.id);
    setSavedMeta({ createdAt: replay.createdAt, ruleVersion: replay.ruleVersion });
    setSelectedTrigger(null);
    setFocusTimestamp(null);
    setStale(false);
  }

  async function runReplay(
    targetRule: RuleView,
    targetSymbol: string,
    targetWindow: number,
    targetChartTimeframe: Timeframe,
  ) {
    if (!targetSymbol) return;
    const seq = ++requestSeq.current;
    setRunning(true);
    setRunError(null);
    try {
      const { replay } = await api.createReplay(targetRule.id, {
        symbol: targetSymbol,
        windowDays: targetWindow,
        chartTimeframe: targetChartTimeframe,
      });
      if (seq !== requestSeq.current) return;
      if (replay.ruleVersion !== targetRule.version) {
        try {
          const { rule: latestRule } = await api.rule(targetRule.id);
          if (seq === requestSeq.current) setRule(latestRule);
        } catch {
          // The replay itself is still valid; the next page load will refresh rule state.
        }
      }
      applyReplay(replay);
      setReplays((previous) => [
        replay,
        ...previous.filter((item) => item.id !== replay.id),
      ].slice(0, 20));
    } catch (error) {
      if (seq !== requestSeq.current) return;
      setRunError(error instanceof Error ? error.message : String(error));
    } finally {
      if (seq === requestSeq.current) setRunning(false);
    }
  }

  async function loadSavedReplay(replayId: string) {
    if (!replayId) return;
    const seq = ++requestSeq.current;
    setLoadingSaved(true);
    setRunError(null);
    try {
      const { replay } = await api.replay(replayId);
      if (seq !== requestSeq.current) return;
      applyReplay(replay);
    } catch (error) {
      if (seq !== requestSeq.current) return;
      setRunError(error instanceof Error ? error.message : String(error));
    } finally {
      if (seq === requestSeq.current) setLoadingSaved(false);
    }
  }

  useEffect(() => {
    if (!id) {
      setLoadError('缺少规则 ID');
      setLoadingRule(false);
      return;
    }
    let active = true;
    requestSeq.current += 1;
    setLoadingRule(true);
    setLoadError(null);
    setRule(null);
    setResult(null);
    setRunError(null);
    setStale(false);
    setRunning(false);
    setReplays([]);
    setSelectedReplayId('');
    setSavedMeta(null);
    setRuleUpdated(false);
    setSymbol('');
    setChartTimeframe('5m');
    api.rule(id)
      .then(async ({ rule: loaded }) => {
        if (!active) return;
        setRule(loaded);
        const firstSymbol = loaded.symbols[0] ?? '';
        const initialChart = (loaded.timeframes[0] ?? '5m') as Timeframe;
        setSymbol(firstSymbol);
        setWindowDays(7);
        setChartTimeframe(initialChart);
        try {
          const { replays: saved } = await api.replays(id, 20);
          if (!active) return;
          setReplays(saved);
          const currentVersion = saved.find((item) => item.ruleVersion === loaded.version);
          if (currentVersion) {
            // A result for the current rule version exists: safe to reuse it.
            const { replay } = await api.replay(currentVersion.id);
            if (!active) return;
            applyReplay(replay);
            setLoadingRule(false);
          } else {
            // Results exist only for older rule versions. Never present a stale
            // snapshot as the current replay; reuse its parameters and run the
            // new rule version once, then keep the old record in history.
            const base = saved[0];
            const fallbackSymbol = base && loaded.symbols.includes(base.symbol) ? base.symbol : firstSymbol;
            const fallbackWindow = base?.windowDays ?? 7;
            const fallbackChart = base?.chartTimeframe ?? initialChart;
            if (base) setRuleUpdated(true);
            setSymbol(fallbackSymbol);
            setWindowDays(fallbackWindow);
            setChartTimeframe(fallbackChart);
            setLoadingRule(false);
            if (fallbackSymbol) await runReplay(loaded, fallbackSymbol, fallbackWindow, fallbackChart);
          }
        } catch (error) {
          if (!active) return;
          setLoadError(error instanceof Error ? error.message : String(error));
          setLoadingRule(false);
        }
      })
      .catch((error) => {
        if (!active) return;
        setLoadError(error instanceof Error ? error.message : String(error));
        setLoadingRule(false);
      });
    return () => {
      active = false;
    };
    // Load the latest saved snapshot once. Running is only explicit from this point on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const replayEvents = useMemo<ChartEventMarker[]>(
    () => result && rule ? result.triggers.map((trigger, index) => ({
      id: `replay-${index}`,
      ruleId: rule.id,
      ruleName: rule.name,
      symbol: result.symbol,
      triggerAt: trigger.triggerAt,
      price: trigger.price,
      triggerMode: trigger.triggerMode,
      note: trigger.conditions.map((condition) => conditionText(condition)).join(' · '),
      deliveryStatus: null,
      label: result.triggers.length <= 40 ? `#${index + 1}` : '',
    })) : [],
    [result, rule],
  );

  function changeSymbol(next: string) {
    setSymbol(next);
    if (result) setStale(true);
  }

  function changeWindow(next: number) {
    setWindowDays(next);
    if (result) setStale(true);
  }

  async function selectChartTimeframe(next: Timeframe) {
    if (!result || !selectedReplayId || next === chartTimeframe || chartLoading) return;
    setChartLoading(true);
    setRunError(null);
    try {
      const data = await api.replayChartCandles(selectedReplayId, next);
      setChartTimeframe(next);
      setViewCandles(data.candles);
      setFocusTimestamp(null);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
    } finally {
      setChartLoading(false);
    }
  }

  function runCurrent() {
    if (!rule) return;
    void runReplay(rule, symbol, windowDays, chartTimeframe);
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      showToast('历史回放链接已复制', 'success');
    } catch {
      showToast('复制链接失败，请手动复制地址栏', 'error');
    }
  }

  if (loadingRule) {
    return (
      <div className="page-wrap">
        <PageHeader eyebrow="规则 / 历史回放" title="历史回放" subtitle="加载规则并回放历史行情…" />
        <LoadingBlock text="正在加载规则和历史行情…" />
      </div>
    );
  }

  if (loadError || !rule) {
    return (
      <div className="page-wrap">
        <PageHeader eyebrow="规则 / 历史回放" title="历史回放" subtitle="无法加载规则" />
        <ErrorBanner message={loadError ?? '规则不存在'} onRetry={() => window.location.reload()} />
        <div className="replay-back-row">
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/rules')}>
            <ArrowLeft size={14} /> 返回规则
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page-wrap replay-page">
      <PageHeader
        eyebrow="规则 / 历史回放"
        title={rule.name}
        subtitle={(
          <span>
            {rule.summary} · {rule.symbols.join(' / ')} · 模拟通知位置，不会发送通知或写入事件
          </span>
        )}
        actions={(
          <>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyLink()}>
              <Copy size={13} /> 复制回放链接
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => navigate('/rules')}>
              <ArrowLeft size={13} /> 返回规则
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => navigate(`/rules/${rule.id}/edit`)}>
              <PenLine size={13} /> 编辑规则
            </button>
          </>
        )}
      />

      <section className="panel replay-controls">
        <div className="panel-padded replay-control-inner">
          <div className="replay-control-grid">
            <div className="form-field">
              <label htmlFor="replay-symbol">回放品种</label>
              <select
                id="replay-symbol"
                className="select"
                data-testid="replay-symbol"
                value={symbol}
                onChange={(event) => changeSymbol(event.target.value)}
              >
                {rule.symbols.map((item) => <option key={item} value={item}>{item}</option>)}
                {symbol && !rule.symbols.includes(symbol) ? <option value={symbol}>{symbol}（已保存记录）</option> : null}
              </select>
            </div>
            <div className="form-field">
              <span className="form-label">回看窗口</span>
              <div className="replay-window-row">
                {WINDOWS.map((days) => (
                  <button
                    key={days}
                    type="button"
                    className={`btn btn-sm ${windowDays === days ? 'btn-primary' : 'btn-secondary'}`}
                    data-testid={`replay-window-${days}`}
                    onClick={() => changeWindow(days)}
                  >
                    最近 {days} 天
                  </button>
                ))}
              </div>
            </div>
            <div className="replay-run-wrap">
              {stale ? <span className="replay-stale">参数已修改</span> : null}
              <button
                type="button"
                className="btn btn-primary replay-run-btn"
                data-testid="run-replay"
                onClick={runCurrent}
                disabled={running || !symbol}
              >
                {running ? <Loader2 size={14} className="spin" /> : <PlayCircle size={14} />}
                {running ? '回放中…' : '运行并保存'}
              </button>
            </div>
          </div>
          <div className="replay-history-row">
            <div className="form-field">
              <label htmlFor="replay-history">已保存回放</label>
              <select
                id="replay-history"
                className="select"
                data-testid="replay-history"
                value={selectedReplayId}
                disabled={running || loadingSaved || !replays.length}
                onChange={(event) => void loadSavedReplay(event.target.value)}
              >
                <option value="">{replays.length ? '选择历史结果…' : '暂无已保存结果'}</option>
                {replays.map((item) => (
                  <option key={item.id} value={item.id}>
                    {formatDateTime(item.createdAt)} · {item.symbol} · {item.windowDays}天 · {item.chartTimeframe} · {item.triggerCount}次 · v{item.ruleVersion}
                  </option>
                ))}
              </select>
            </div>
            <div className="replay-history-meta">
              {savedMeta ? (
                <span>最近保存 {formatDateTime(savedMeta.createdAt)} · 规则 v{savedMeta.ruleVersion}</span>
              ) : (
                <span>首次回放会自动保存；刷新页面直接载入最近结果，不会重新计算。</span>
              )}
              {loadingSaved ? <span className="replay-loading"><Loader2 size={11} className="spin" /> 载入中…</span> : null}
            </div>
          </div>
          <div className="muted-small replay-control-note">
            按已收盘 K 线评估条件，通知位置标注在触发 K 线上。K 线周期标签只切换图表视图，不重新计算信号；点击“运行并保存”时按当前图表周期写入历史结果。窗口内最多保留 500 条触发快照；1m / 3m 会自动缩短历史窗口。
          </div>
        </div>
      </section>

      {ruleUpdated ? (
        <div className="replay-updated-banner" data-testid="replay-rule-updated">
          检测到规则已更新。已按当前规则版本自动生成新的回放结果；旧版本结果仍保留在“已保存回放”中。
        </div>
      ) : null}

      {runError ? <ErrorBanner message={runError} onRetry={runCurrent} /> : null}

      {running && !result ? <LoadingBlock text="正在补全本地历史 K 线并回放规则…" /> : null}

      {result ? (
        <div data-testid="replay-result">
          <div className="trial-metrics replay-metrics">
            <div className="trial-metric"><div className="k">通知位置</div><div className="v">{result.triggerCount}<small>次</small></div></div>
            <div className="trial-metric"><div className="k">平均每天</div><div className="v">{result.perDay}<small>次/天</small></div></div>
            <div className="trial-metric"><div className="k">回看窗口</div><div className="v">{result.windowDays}<small>天</small></div></div>
            <div className="trial-metric"><div className="k">清单条数</div><div className="v">{result.triggers.length}<small>条</small></div></div>
          </div>

          {savedMeta && savedMeta.ruleVersion !== rule.version ? (
            <div className="warning-banner">
              <TriangleAlert size={13} />
              <div>这条结果基于规则 v{savedMeta.ruleVersion}，当前规则为 v{rule.version}。重新运行可生成最新结果，历史结果仍会保留。</div>
            </div>
          ) : null}

          <div className="replay-data-row" data-testid="replay-data-info">
            <span className={`replay-source source-${result.data.source}`}>
              数据：{result.data.source === 'local' ? '本地缓存' : result.data.source === 'local+remote' ? '本地 + 增量补齐' : '远程补全'}
            </span>
            <span>本地 {result.data.localBars} 根</span>
            <span>增量 {result.data.fetchedBars} 根</span>
            <span>覆盖 {(result.data.coverage * 100).toFixed(1)}%</span>
            {result.data.gaps > 0 ? <span className="replay-data-warn">未覆盖 {result.data.gaps} 根</span> : null}
          </div>

          <div className="warning-banner">
            <TriangleAlert size={13} />
            <div>
              {result.warning}
              {result.triggersTruncated ? ` 触发超过 500 条，清单与图表只展示前 ${result.triggers.length} 条。` : ''}
            </div>
          </div>

          <section className="panel replay-chart-card">
            <div className="panel-head">
              <div>
                <div className="panel-title">历史 K 线与通知位置</div>
                <div className="panel-sub">
                  {result.symbol} · 图表 {chartTimeframe} · 规则 {result.signalTimeframe} · 图上标记与下方触发清单一致
                </div>
              </div>
              <span className="replay-chart-badge"><span className="replay-chart-dot" /> 通知位置 {result.triggers.length}</span>
            </div>
            <div className="replay-chart-wrap" data-testid="replay-chart">
              <ReplayProChart
                symbol={result.symbol}
                timeframe={chartTimeframe}
                pricePrecision={2}
                volumePrecision={0}
                candles={viewCandles}
                events={replayEvents}
                focusTimestamp={focusTimestamp}
                onTimeframeChange={(next) => void selectChartTimeframe(next as Timeframe)}
                timeframeLoading={chartLoading}
                onEventSelect={(event) => {
                  const index = Number(event.id.replace('replay-', ''));
                  if (!Number.isFinite(index)) return;
                  setSelectedTrigger(index);
                  setFocusTimestamp(event.triggerAt);
                  document.querySelector(`[data-replay-index="${index}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                }}
              />
            </div>
            <div className="replay-chart-note">
              使用与「专业图表」相同的 KLineChart 工作台：支持指标、Volume Profile、画线、缩放、截图和全屏。图上橙色标记对应下方清单，触发较少时显示 #编号；点击清单行可在图中定位，触发较多时只显示标记点。历史盘中 tick 无法完整还原，盘中规则按收盘确认口径模拟。
            </div>
          </section>

          <section className="panel replay-list-panel" data-testid="replay-list">
            <div className="panel-head">
              <div>
                <div className="panel-title">触发清单</div>
                <div className="panel-sub">按通知时间升序 · 条件快照为触发时的已收盘 K 线值 · 清单区域可滚动</div>
              </div>
              <span className="muted-small">{result.triggers.length} / {result.triggerCount} 条</span>
            </div>
            {result.triggers.length === 0 ? (
              <div className="empty-table replay-empty">
                窗口内没有触发。可以放宽条件、缩短冷却时间，或切换到更长的回看窗口。
              </div>
            ) : (
              <div className="replay-table">
                <div className="replay-table-head" aria-hidden="true">
                  <span>#</span><span>通知时间</span><span>触发价</span><span>模式</span><span>条件快照</span>
                </div>
                {result.triggers.map((trigger, index) => (
                  <div
                    className={`replay-row${selectedTrigger === index ? ' selected' : ''}`}
                    data-testid="replay-row"
                    data-replay-index={index}
                    key={`${trigger.triggerAt}-${index}`}
                    role="button"
                    tabIndex={0}
                    title="在图中定位这条触发"
                    onClick={() => {
                      setSelectedTrigger(index);
                      setFocusTimestamp(trigger.triggerAt);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelectedTrigger(index);
                        setFocusTimestamp(trigger.triggerAt);
                      }
                    }}
                  >
                    <div className="replay-index">#{index + 1}</div>
                    <div className="replay-when">
                      <strong>{formatDateTime(trigger.triggerAt)}</strong>
                      {trigger.barCloseTime !== trigger.triggerAt ? (
                        <small>K 线 {formatDateTime(trigger.barCloseTime)}</small>
                      ) : null}
                    </div>
                    <div className="replay-price">{formatNumber(trigger.price)}</div>
                    <div className="replay-mode">{triggerModeText(trigger)}</div>
                    <div className="replay-conditions">
                      {trigger.conditions.map((condition) => (
                        <span className={`replay-cond${condition.truth ? ' ok' : ' no'}`} key={condition.conditionId} title={conditionText(condition)}>
                          {condition.truth ? '✓' : '✕'} {conditionText(condition)}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {result.triggersTruncated ? (
              <div className="replay-list-note">
                <RotateCcw size={12} /> 结果超过 500 条，仅展示前 500 条触发快照。
              </div>
            ) : null}
          </section>
        </div>
      ) : !running && !runError ? (
        <div className="empty-state replay-empty-state">
          <div className="es-title">开始历史回放</div>
          <div className="es-desc">选择品种和窗口，回放规则在历史 K 线上的触发位置，并查看完整条件快照。</div>
          <button type="button" className="btn btn-primary" onClick={runCurrent} disabled={!symbol}>
            <PlayCircle size={14} /> 运行回放
          </button>
        </div>
      ) : null}

      <div className="page-foot">
        <span>回放基于历史已收盘 K 线，不发送通知、不写入正式事件。</span>
        <span>HISTORICAL REPLAY · {result?.triggers.length ?? 0} TRIGGERS</span>
      </div>
    </div>
  );
}
