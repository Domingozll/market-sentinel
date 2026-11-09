import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Copy, PenLine, Plus, Search, Trash2 } from 'lucide-react';
import type { RuleView } from '../../shared/types';
import { api } from '../api';
import { useAppData, useLiveVersion, useToast } from '../context';
import { aggregateTone, formatDateTime, TRIGGER_MODE_TEXT } from '../lib/format';
import {
  ConfirmDialog,
  ErrorBanner,
  LoadingBlock,
  PageHeader,
  StatusPill,
  Toggle,
} from '../components/ui';

const templates = [
  { key: 'j-high', title: 'J 值高位提醒', desc: '15m · KDJ J ≥ 90' },
  { key: 'mid-slope', title: '中轨转弱', desc: '5m · 中轨斜率 < 0' },
  { key: 'lower-touch', title: '下轨触及', desc: '5m · 最低价 ≤ 布林带下轨' },
  { key: 'trend-pullback', title: '趋势回踩组合', desc: '15m 斜率 > 0 且 5m 触及下轨' },
  { key: 'rsi-oversold', title: 'RSI 超卖', desc: '5m · RSI ≤ 30' },
  { key: 'volume-spike', title: '量能放大', desc: '5m · 量能倍数 ≥ 1.5' },
];

export function RulesPage() {
  const navigate = useNavigate();
  const { data, loading, error, refresh } = useAppData();
  const liveVersion = useLiveVersion();
  const { showToast } = useToast();
  const [tab, setTab] = useState<'all' | 'enabled' | 'paused'>('all');
  const [query, setQuery] = useState('');
  const [symbolFilter, setSymbolFilter] = useState('');
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<RuleView | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const rules = data?.rules ?? [];
  const symbols = useMemo(() => [...new Set(rules.flatMap((rule) => rule.symbols))].sort(), [rules]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rules.filter((rule) => {
      if (tab === 'enabled' && !rule.enabled) return false;
      if (tab === 'paused' && rule.enabled) return false;
      if (symbolFilter && !rule.symbols.includes(symbolFilter)) return false;
      if (needle && !`${rule.name} ${rule.summary} ${rule.symbols.join(' ')}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [query, rules, symbolFilter, tab]);

  const enabledCount = rules.filter((rule) => rule.enabled).length;
  const pausedCount = rules.filter((rule) => !rule.enabled).length;

  async function toggleRule(rule: RuleView, enabled: boolean) {
    setBusyIds((previous) => new Set(previous).add(rule.id));
    try {
      await api.setRuleEnabled(rule.id, enabled);
      await refresh();
      showToast(enabled ? '规则已启用。当前状态将重新建立基线。' : '规则已暂停，不再判断。', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusyIds((previous) => {
        const next = new Set(previous);
        next.delete(rule.id);
        return next;
      });
    }
  }

  async function duplicateRule(rule: RuleView) {
    setBusyIds((previous) => new Set(previous).add(rule.id));
    try {
      const result = await api.duplicateRule(rule.id);
      await refresh();
      showToast('已创建副本（默认暂停）', 'success');
      navigate(`/rules/${result.rule.id}/edit`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusyIds((previous) => {
        const next = new Set(previous);
        next.delete(rule.id);
        return next;
      });
    }
  }

  async function deleteRule() {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      await api.deleteRule(deleteTarget.id);
      setDeleteTarget(null);
      await refresh();
      showToast('规则已归档，历史事件仍然保留。', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setDeleteBusy(false);
    }
  }

  if (loading && !data) return <LoadingBlock text="正在加载规则…" />;
  if (!data) return <ErrorBanner message={error ?? '无法加载规则'} onRetry={() => void refresh()} />;

  return (
    <div className="page-wrap">
      {error ? <ErrorBanner message={error} onRetry={() => void refresh()} /> : null}
      <PageHeader
        eyebrow="工作台"
        title="规则"
        subtitle={`${rules.length} 条规则 · ${enabledCount} 条已启用 · 修改规则会重置当前满足状态`}
        actions={
          <button type="button" className="btn btn-primary" onClick={() => navigate('/rules/new')}>
            <Plus size={14} /> 新建规则
          </button>
        }
      />

      <div className="toolbar">
        <div className="toolbar-left">
          <div className="filter-tabs">
            <button type="button" className={`filter-tab${tab === 'all' ? ' active' : ''}`} onClick={() => setTab('all')}>全部 <span className="n">{rules.length}</span></button>
            <button type="button" className={`filter-tab${tab === 'enabled' ? ' active' : ''}`} onClick={() => setTab('enabled')}>已启用 <span className="n">{enabledCount}</span></button>
            <button type="button" className={`filter-tab${tab === 'paused' ? ' active' : ''}`} onClick={() => setTab('paused')}>已暂停 <span className="n">{pausedCount}</span></button>
          </div>
          <div className="search-box">
            <Search size={12} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索规则…" aria-label="搜索规则" />
          </div>
        </div>
        <div className="toolbar-right">
          <select
            className="selectish"
            aria-label="按品种筛选"
            value={symbolFilter}
            onChange={(event) => setSymbolFilter(event.target.value)}
          >
            <option value="">全部品种</option>
            {symbols.map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}
          </select>
        </div>
      </div>

      <div className="rules-table">
        <div className="rule-list-grid" style={{ padding: '8px 17px', color: '#586b7c', fontSize: 9, letterSpacing: '.04em' }}>
          <span>开关</span><span>规则 / 条件</span><span>状态</span><span>上次触发</span><span>24h</span><span style={{ textAlign: 'right' }}>操作</span>
        </div>
        {filtered.length === 0 ? (
          <div className="empty-table">
            {rules.length === 0 ? (
              <div>
                <div style={{ color: '#a7b9c6', marginBottom: 6 }}>还没有规则</div>
                <div className="muted-small">从下方模板开始，或创建一条完全自定义的规则。</div>
              </div>
            ) : '没有符合筛选条件的规则'}
          </div>
        ) : filtered.map((rule) => (
          <RuleRow
            key={`${rule.id}-${liveVersion}`}
            rule={rule}
            busy={busyIds.has(rule.id)}
            onToggle={(enabled) => void toggleRule(rule, enabled)}
            onEdit={() => navigate(`/rules/${rule.id}/edit`)}
            onDuplicate={() => void duplicateRule(rule)}
            onDelete={() => setDeleteTarget(rule)}
          />
        ))}
      </div>

      <div className="template-strip">
        <div className="strip-head">
          <h3>从模板创建</h3>
          <span>模板会预填条件，不会自动启用</span>
        </div>
        <div className="template-grid">
          {templates.map((template) => (
            <button
              type="button"
              key={template.key}
              className="template-card"
              onClick={() => navigate(`/rules/new?template=${template.key}`)}
            >
              <div className="t-title">{template.title}</div>
              <div className="t-desc">{template.desc}</div>
              <div className="t-add">使用模板 <span>→</span></div>
            </button>
          ))}
        </div>
      </div>
      <div className="page-foot">
        <span>规则快照与事件记录相互独立，修改规则不会改写历史。</span>
        <span>{rules.length} RULES · {enabledCount} ACTIVE</span>
      </div>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除规则"
        message={<>确定删除 <b>{deleteTarget?.name}</b> 吗？规则会停止监控，但历史事件和投递记录会保留。</>}
        confirmText="删除规则"
        danger
        busy={deleteBusy}
        onConfirm={() => void deleteRule()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function RuleRow({
  rule,
  busy,
  onToggle,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  rule: RuleView;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const tone = aggregateTone(rule.ruleStatus);
  return (
    <div className="rule-list-grid">
      <Toggle checked={rule.enabled} label={`启用规则 ${rule.name}`} disabled={busy} onChange={onToggle} />
      <button type="button" className="rule-main-btn" onClick={onEdit}>
        <div className="name">
          {rule.name}
          {rule.symbols.slice(0, 3).map((symbol) => <span className="symbol-tag" key={symbol}>{symbol}</span>)}
          {rule.symbols.length > 3 ? <span className="symbol-tag">+{rule.symbols.length - 3}</span> : null}
        </div>
        <div className="desc">{rule.summary}</div>
      </button>
      <div>
        <StatusPill tone={tone}>{rule.statusLabel}</StatusPill>
        <div className="rule-mode" style={{ marginTop: 3 }}>{TRIGGER_MODE_TEXT[rule.triggerMode]}<small>{rule.timeframes.join(' + ')}</small></div>
      </div>
      <div className="last-cell">
        {rule.lastTriggerAt ? formatDateTime(rule.lastTriggerAt) : '—'}
        <small>{rule.lastTriggerAt ? '最近触发' : '尚未触发'}</small>
      </div>
      <div className="count-cell">{rule.triggerCount24h}<small> 次</small></div>
      <div className="rule-actions">
        <button type="button" className="icon-btn" title="编辑" onClick={onEdit} disabled={busy}><PenLine size={13} /></button>
        <button type="button" className="icon-btn" title="复制" onClick={onDuplicate} disabled={busy}><Copy size={13} /></button>
        <button type="button" className="icon-btn danger" title="删除" onClick={onDelete} disabled={busy}><Trash2 size={13} /></button>
      </div>
    </div>
  );
}
