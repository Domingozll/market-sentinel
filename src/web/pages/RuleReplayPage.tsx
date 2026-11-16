import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Copy, Loader2, PenLine, PlayCircle, RotateCcw, TriangleAlert } from 'lucide-react';
import {
  COMPARATOR_LABEL,
  SERIES_CATALOG,
  type ConditionEvaluation,
  type RuleView,
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
import { MarketChart, type ChartMarker } from '../components/MarketChart';

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

function chartCandle(candle: TrialResult['candles'][number], result: TrialResult) {
  return {
    instId: result.symbol,
    timeframe: result.timeframe,
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
  };
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
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TrialResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const requestSeq = useRef(0);

  async function runReplay(targetRule: RuleView, targetSymbol: string, targetWindow: number) {
    if (!targetSymbol) return;
    const seq = ++requestSeq.current;
    setRunning(true);
    setRunError(null);
    try {
      const next = await api.trialRuleById(targetRule.id, targetSymbol, targetWindow);
      if (seq !== requestSeq.current) return;
      setResult(next);
      setWindowDays(next.windowDays);
      setStale(false);
    } catch (error) {
      if (seq !== requestSeq.current) return;
      setRunError(error instanceof Error ? error.message : String(error));
    } finally {
      if (seq === requestSeq.current) setRunning(false);
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
    api.rule(id)
      .then(({ rule: loaded }) => {
        if (!active) return;
        setRule(loaded);
        const firstSymbol = loaded.symbols[0] ?? '';
        setSymbol(firstSymbol);
        setWindowDays(7);
        setLoadingRule(false);
        if (firstSymbol) void runReplay(loaded, firstSymbol, 7);
      })
      .catch((error) => {
        if (!active) return;
        setLoadError(error instanceof Error ? error.message : String(error));
        setLoadingRule(false);
      });
    return () => {
      active = false;
    };
    // The replay is intentionally run once per rule id; changing controls must be explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const chartCandles = useMemo(
    () => (result ? result.candles.map((candle) => chartCandle(candle, result)) : []),
    [result],
  );
  const markers = useMemo<ChartMarker[]>(
    () => result?.triggers.map((trigger, index) => ({
      triggerAt: trigger.triggerAt,
      price: trigger.price,
      label: `#${index + 1}`,
    })) ?? [],
    [result],
  );

  function changeSymbol(next: string) {
    setSymbol(next);
    if (result) setStale(true);
  }

  function changeWindow(next: number) {
    setWindowDays(next);
    if (result) setStale(true);
  }

  function runCurrent() {
    if (!rule) return;
    void runReplay(rule, symbol, windowDays);
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
                {running ? '回放中…' : '运行回放'}
              </button>
            </div>
          </div>
          <div className="muted-small replay-control-note">
            按已收盘 K 线评估条件，通知位置标注在触发 K 线上。窗口内最多保留 500 条触发快照；1m / 3m 会自动缩短历史窗口。
          </div>
        </div>
      </section>

      {runError ? <ErrorBanner message={runError} onRetry={runCurrent} /> : null}

      {running && !result ? <LoadingBlock text="正在拉取历史 K 线并回放规则…" /> : null}

      {result ? (
        <div data-testid="replay-result">
          <div className="trial-metrics replay-metrics">
            <div className="trial-metric"><div className="k">通知位置</div><div className="v">{result.triggerCount}<small>次</small></div></div>
            <div className="trial-metric"><div className="k">平均每天</div><div className="v">{result.perDay}<small>次/天</small></div></div>
            <div className="trial-metric"><div className="k">回看窗口</div><div className="v">{result.windowDays}<small>天</small></div></div>
            <div className="trial-metric"><div className="k">清单条数</div><div className="v">{result.triggers.length}<small>条</small></div></div>
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
                  {result.symbol} · {result.timeframe} · 图上标记与下方触发清单一致
                </div>
              </div>
              <span className="replay-chart-badge"><span className="replay-chart-dot" /> 通知位置 {result.triggers.length}</span>
            </div>
            <div className="replay-chart-wrap" data-testid="replay-chart">
              <MarketChart
                candles={chartCandles}
                timeframe={result.timeframe}
                markers={markers}
                markerLimit={500}
                initialBars={Math.max(chartCandles.length, 120)}
                height={390}
                ariaLabel={`${rule.name} 历史 K 线回放`}
              />
            </div>
            <div className="replay-chart-note">
              图表覆盖本次回放窗口；{result.triggers.length <= 40 ? '橙色 #编号 标记与下方清单一一对应' : '橙色标记点对应下方清单，触发较多时仅显示标记点、不显示编号'}，可拖动或缩放图表查看细节。历史盘中 tick 无法完整还原，盘中规则按收盘确认口径模拟。
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
                  <div className="replay-row" data-testid="replay-row" key={`${trigger.triggerAt}-${index}`}>
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
