import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react';
import { COMPARATOR_LABEL, NOTIFICATION_CHANNEL_LABEL, SERIES_CATALOG, type EventView } from '../../shared/types';
import { api } from '../api';
import { useAppData, useLiveVersion, useToast } from '../context';
import {
  deliveryTone,
  deliveryText,
  formatDateTime,
  formatNumber,
  formatPrice,
  formatTime,
  summarizeExpression,
  TRIGGER_MODE_TEXT,
} from '../lib/format';
import { ErrorBanner, LoadingBlock, PageHeader, StatusPill } from '../components/ui';

const STATUS_TABS: { key: string; label: string }[] = [
  { key: '', label: '全部' },
  { key: 'sent', label: '已送达' },
  { key: 'failed', label: '发送失败' },
  { key: 'pending', label: '待发送' },
  { key: 'skipped', label: '未通知' },
];

const RANGE_OPTIONS = [
  { key: '1d', label: '最近 24 小时', ms: 86_400_000 },
  { key: '7d', label: '最近 7 天', ms: 7 * 86_400_000 },
  { key: '30d', label: '最近 30 天', ms: 30 * 86_400_000 },
  { key: 'all', label: '全部时间', ms: 0 },
];

export function EventsPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { data, refresh } = useAppData();
  const liveVersion = useLiveVersion();
  const { showToast } = useToast();
  const [status, setStatus] = useState(searchParams.get('status') ?? '');
  const [range, setRange] = useState('7d');
  const [ruleId, setRuleId] = useState('');
  const [offset, setOffset] = useState(0);
  const [events, setEvents] = useState<EventView[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<EventView | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const limit = 30;

  const from = useMemo(() => {
    const option = RANGE_OPTIONS.find((item) => item.key === range);
    if (!option || !option.ms) return undefined;
    return Date.now() - option.ms;
  }, [range]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.events({ status: status || undefined, ruleId: ruleId || undefined, from, limit, offset })
      .then((result) => {
        if (!active) return;
        setEvents(result.events);
        setTotal(result.total);
        setError(null);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [status, ruleId, from, offset, liveVersion]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDrawer();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [drawerOpen]);

  useEffect(() => {
    if (!selected || !drawerOpen) return;
    let active = true;
    api.event(selected.id)
      .then(({ event }) => {
        if (active) {
          setSelected(event);
          setDetailError(null);
        }
      })
      .catch((err: unknown) => {
        if (active) setDetailError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, [selected?.id, drawerOpen, liveVersion]);

  function openEvent(event: EventView) {
    setSelected(event);
    setDrawerOpen(true);
    setDetailError(null);
  }

  function closeDrawer() {
    setDrawerOpen(false);
  }

  async function retryDelivery() {
    if (!selected) return;
    setRetrying(true);
    setDetailError(null);
    try {
      const result = await api.retryEvent(selected.id);
      setSelected(result.event);
      showToast('已重新加入发送队列', 'success');
      setTimeout(() => {
        void api.event(selected.id).then(({ event }) => setSelected(event)).catch(() => undefined);
      }, 1500);
      await refresh();
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : String(err));
      showToast('重新发送失败：' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setRetrying(false);
    }
  }

  function exportCsv() {
    if (!events.length) return;
    const header = ['触发时间', '规则', '品种', '周期', '触发价', '触发模式', '投递状态', '事件ID'];
    const rows = events.map((event) => [
      formatDateTime(event.triggerAt, true),
      event.ruleName,
      event.symbol,
      [...new Set(event.conditions.map((c) => c.timeframe))].join('+'),
      event.price,
      TRIGGER_MODE_TEXT[event.triggerMode],
      deliveryText(event.delivery),
      event.id,
    ]);
    const csv = [header, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `market-sentinel-events-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const currentPage = Math.floor(offset / limit) + 1;
  const pageCount = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="page-wrap">
      {error ? <ErrorBanner message={error} onRetry={() => setOffset((value) => value + 0)} /> : null}
      <PageHeader
        eyebrow="工作台"
        title="事件"
        subtitle={`所有触发与 Discord 投递记录 · 共 ${total} 条`}
        actions={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setOffset(0)}>
              <RefreshCw size={14} /> 刷新
            </button>
            <button type="button" className="btn btn-secondary" onClick={exportCsv} disabled={!events.length}>
              <Download size={14} /> 导出本页 CSV
            </button>
          </>
        }
      />

      <div className="events-toolbar">
        <div className="filter-tabs">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={`filter-tab${status === tab.key ? ' active' : ''}`}
              onClick={() => {
                setStatus(tab.key);
                setOffset(0);
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="toolbar-right">
          <select className="selectish" value={ruleId} onChange={(event) => { setRuleId(event.target.value); setOffset(0); }} aria-label="按规则筛选">
            <option value="">全部规则</option>
            {data?.rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.name}</option>)}
          </select>
          <select className="selectish" value={range} onChange={(event) => { setRange(event.target.value); setOffset(0); }} aria-label="日期范围">
            {RANGE_OPTIONS.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
          </select>
        </div>
      </div>

      <div className="events-card">
        <div className="event-table-scroll">
          <div className="event-head-real">
            <span>触发时间</span><span>规则</span><span>品种 / 周期</span><span style={{ textAlign: 'right' }}>触发价</span><span>投递状态</span><span />
          </div>
          {loading ? <LoadingBlock text="正在加载事件…" /> : events.length === 0 ? (
            <div className="empty-table">
              {status || ruleId ? '没有符合筛选条件的事件。' : '还没有触发记录。规则进入监控后，事件会出现在这里。'}
            </div>
          ) : events.map((event) => (
            <button type="button" className="event-row-real" key={event.id} onClick={() => openEvent(event)}>
              <span className="event-time-cell">
                {formatDateTime(event.triggerAt)}
                <small>{event.triggerMode === 'intrabar' ? (event.closeConfirmed === false ? '收盘未确认' : '盘中') : '收盘确认'}</small>
              </span>
              <span className="event-real-rule">
                {event.ruleName}
                <small>{event.conditions.length} 个条件 · v{event.ruleVersion}</small>
              </span>
              <span className="event-real-symbol">
                {event.symbol}
                <small>{[...new Set(event.conditions.map((c) => c.timeframe))].join(' + ')} · {TRIGGER_MODE_TEXT[event.triggerMode]}</small>
              </span>
              <span className="event-real-price">{formatPrice(event.price)}</span>
              <span className="event-status-cell">
                <StatusPill tone={deliveryTone(event.delivery?.status)}>{deliveryText(event.delivery)}</StatusPill>
              </span>
              <span style={{ color: '#465969', display: 'grid', placeItems: 'center' }}><ChevronRight size={12} /></span>
            </button>
          ))}
        </div>
        <div className="event-table-footer">
          <span>第 {currentPage} / {pageCount} 页 · {total} 条</span>
          <div className="row">
            <button type="button" className="btn btn-secondary btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
              <ChevronLeft size={12} /> 上一页
            </button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={offset + limit >= total} onClick={() => setOffset(offset + limit)}>
              下一页 <ChevronRight size={12} />
            </button>
          </div>
        </div>
      </div>

      <div className="page-foot">
        <span>事件保存触发时的条件快照，修改规则不会改写历史。</span>
        <span>{total} EVENTS</span>
      </div>

      <div
        className={`drawer-overlay${drawerOpen ? ' open' : ''}`}
        onClick={closeDrawer}
        aria-hidden={!drawerOpen}
      />
      <aside className={`drawer${drawerOpen ? ' open' : ''}`} aria-hidden={!drawerOpen} aria-label="事件详情">
        <div className="drawer-head">
          <div>
            <div className="drawer-kicker">EVENT DETAIL</div>
            <div className="drawer-title">{selected?.ruleName ?? '事件详情'}</div>
            <div className="drawer-sub">
              {selected ? `${selected.symbol} · ${formatDateTime(selected.triggerAt, true)} CST` : '—'}
            </div>
          </div>
          <button type="button" className="close-x" onClick={closeDrawer} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="drawer-body">
          {detailError ? <ErrorBanner message={detailError} /> : null}
          {selected ? (
            <>
              <div className="detail-block">
                <div className="row-between" style={{ marginBottom: 8 }}>
                  <h4 style={{ margin: 0 }}>触发快照</h4>
                  <StatusPill tone={deliveryTone(selected.delivery?.status)}>
                    {deliveryText(selected.delivery)}
                  </StatusPill>
                </div>
                <div className="detail-kv-grid">
                  <div className="detail-kv"><div className="k">触发价</div><div className="v">{formatPrice(selected.price)}</div></div>
                  <div className="detail-kv"><div className="k">触发模式</div><div className="v">{TRIGGER_MODE_TEXT[selected.triggerMode]}</div></div>
                  <div className="detail-kv"><div className="k">K线时间</div><div className="v">{formatDateTime(selected.triggerBarTs, true)}</div></div>
                  <div className="detail-kv"><div className="k">规则版本</div><div className="v">v{selected.ruleVersion}</div></div>
                  {selected.triggerMode === 'intrabar' ? (
                    <div className="detail-kv"><div className="k">收盘确认</div><div className="v">{selected.closeConfirmed === null ? '未确认' : selected.closeConfirmed ? '已确认' : '收盘未确认'}</div></div>
                  ) : null}
                  <div className="detail-kv"><div className="k">事件 ID</div><div className="v" style={{ wordBreak: 'break-all' }}>{selected.id}</div></div>
                </div>
              </div>
              <div className="detail-block">
                <h4>条件快照</h4>
                {selected.conditions.map((condition) => (
                  <div className="detail-condition-line" key={condition.conditionId}>
                    <span className={`detail-condition-mark${condition.truth ? '' : ' no'}`}>{condition.truth ? '✓' : '×'}</span>
                    <div>
                      <div className="detail-condition-name">
                        {condition.timeframe} {SERIES_CATALOG[condition.leftSeries].label} {COMPARATOR_LABEL[condition.cmp]}{' '}
                        {condition.rightSeries ? SERIES_CATALOG[condition.rightSeries].label : formatNumber(condition.rightValue)}
                      </div>
                      <div className="detail-condition-desc">
                        实际 {formatNumber(condition.leftValue)}{condition.rightSeries ? ` / ${formatNumber(condition.rightValue)}` : ''} · K线 {formatDateTime(condition.barOpenTime)}
                      </div>
                    </div>
                    <div className="detail-condition-value">{condition.truth ? 'true' : 'false'}</div>
                  </div>
                ))}
                <div className="form-section-note" style={{ marginTop: 9 }}>
                  {summarizeExpression(selected.expression)}
                </div>
              </div>
              <div className="detail-block">
                <h4>通知投递</h4>
                <div className="delivery-history">
                  <div className="delivery-history-row"><span className="k">通知渠道</span><span>{NOTIFICATION_CHANNEL_LABEL[selected.delivery?.channel ?? 'discord']}</span></div>
                  <div className="delivery-history-row">
                    <span className="k">当前状态</span>
                    <span>{deliveryText(selected.delivery, '无投递记录')}</span>
                  </div>
                  <div className="delivery-history-row"><span className="k">尝试次数</span><span>{selected.delivery?.attempts ?? 0}</span></div>
                  <div className="delivery-history-row"><span className="k">HTTP 状态</span><span>{selected.delivery?.lastHttpStatus ?? '—'}</span></div>
                  <div className="delivery-history-row"><span className="k">外部消息 ID</span><span>{selected.delivery?.externalMessageId ?? '—'}</span></div>
                  {selected.delivery?.lastError ? <div className="delivery-history-row"><span className="k">最近错误</span><span className="error-text" style={{ textAlign: 'right', maxWidth: 280 }}>{selected.delivery.lastError}</span></div> : null}
                </div>
                {selected.delivery?.channel === 'pushplus' && selected.delivery.status === 'sent' ? (
                  <div className="muted-small" style={{ marginTop: 8 }}>PushPlus 返回成功表示请求已受理；最终微信送达以 PushPlus 流水号/微信为准。</div>
                ) : null}
              </div>
              {selected.note ? <div className="detail-block"><h4>备注</h4><div className="form-section-note">{selected.note}</div></div> : null}
            </>
          ) : detailLoading ? <LoadingBlock /> : null}
        </div>
        <div className="drawer-footer">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              if (selected?.ruleId) {
                closeDrawer();
                navigate(`/rules/${selected.ruleId}/edit`);
              }
            }}
            disabled={!selected?.ruleId}
          >
            打开规则
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void retryDelivery()}
            disabled={retrying || !selected || !selected.delivery || !['dead', 'skipped', 'pending'].includes(selected.delivery.status)}
          >
            {retrying ? <Loader2 size={12} className="spin" /> : null}
            {retrying ? '重试中…' : '重新发送'}
          </button>
        </div>
      </aside>
    </div>
  );
}
