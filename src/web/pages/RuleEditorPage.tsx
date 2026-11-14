import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  ClipboardList,
  Loader2,
  PlayCircle,
  Save,
  Settings2,
  TriangleAlert,
} from 'lucide-react';
import {
  COMPARATOR_LABEL,
  SERIES_CATALOG,
  TRIGGER_MODE_LABEL,
  type Condition,
  type ConditionEvaluation,
  type ConditionGroup,
  type RuleDraft,
  type TrialResult,
  type TriggerMode,
} from '../../shared/types';
import { ApiError, api } from '../api';
import { useAppData, useToast } from '../context';
import {
  formatDateTime,
  formatNumber,
  formatPrice,
  formatTime,
  summarizeExpression,
} from '../lib/format';
import { draftFromTemplate, RULE_TEMPLATES } from '../lib/templates';
import { ConfirmDialog, ErrorBanner, LoadingBlock, StatusPill } from '../components/ui';
import { RuleBuilder } from '../components/RuleBuilder';
import { SymbolPicker } from '../components/SymbolPicker';
import { DiscordPreview } from '../components/DiscordPreview';
import { PushplusPreview } from '../components/PushplusPreview';
import { TrialModal } from '../components/TrialModal';

type EditableDraft = Omit<RuleDraft, 'expression'> & { expression: ConditionGroup; enabled: boolean };

function asGroup(expression: RuleDraft['expression']): ConditionGroup {
  return expression.kind === 'group'
    ? expression
    : { kind: 'group', op: 'AND', children: [expression] };
}

function initialDraft(templateKey: string | null): EditableDraft {
  const raw = draftFromTemplate(templateKey, 300);
  return { ...raw, expression: asGroup(raw.expression), enabled: true };
}

function flattenExpression(node: ConditionGroup | Condition): Condition[] {
  if (node.kind === 'condition') return [node];
  return node.children.flatMap(flattenExpression);
}

function toPayload(draft: EditableDraft): RuleDraft & { enabled: boolean } {
  return {
    name: draft.name.trim(),
    symbols: draft.symbols,
    triggerMode: draft.triggerMode,
    cooldownSec: draft.cooldownSec,
    expression: draft.expression,
    note: draft.note ?? '',
    enabled: draft.enabled,
  };
}

function validationMessages(error: unknown): string[] {
  if (error instanceof ApiError) {
    if (Array.isArray(error.details)) {
      return error.details.map((item) =>
        item && typeof item === 'object' && 'message' in item
          ? String((item as { message: unknown }).message)
          : String(item),
      );
    }
    return [error.message];
  }
  return [error instanceof Error ? error.message : String(error)];
}

export function RuleEditorPage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const templateKey = searchParams.get('template');
  const isEdit = Boolean(id);
  const { data, refresh } = useAppData();
  const { showToast } = useToast();
  const [draft, setDraft] = useState<EditableDraft>(() => initialDraft(templateKey));
  const [loading, setLoading] = useState(isEdit);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErrors, setSaveErrors] = useState<string[]>([]);
  const [preview, setPreview] = useState<{
    summary: string;
    warnings: { code: string; message: string; conditionId?: string }[];
    results: {
      symbol: string;
      ok: boolean;
      evaluation?: import('../../shared/types').RuleEvaluation;
      reason?: string;
      message?: string;
    }[];
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [trialOpen, setTrialOpen] = useState(false);
  const [trialSymbol, setTrialSymbol] = useState('');
  const [trialWindow, setTrialWindow] = useState(7);
  const [trialLoading, setTrialLoading] = useState(false);
  const [trialError, setTrialError] = useState<string | null>(null);
  const [trialResult, setTrialResult] = useState<TrialResult | null>(null);
  const [templateConfirm, setTemplateConfirm] = useState<string | null>(null);
  const appliedDefaultCooldown = useRef(false);

  useEffect(() => {
    if (!id) {
      const next = initialDraft(templateKey);
      setDraft(next);
      setLoading(false);
      setLoadError(null);
      setTrialSymbol(next.symbols[0] ?? '');
      return;
    }
    let active = true;
    setLoading(true);
    api.rule(id)
      .then(({ rule }) => {
        if (!active) return;
        const expression: ConditionGroup =
          rule.expression.kind === 'group'
            ? (JSON.parse(JSON.stringify(rule.expression)) as ConditionGroup)
            : { kind: 'group', op: 'AND', children: [JSON.parse(JSON.stringify(rule.expression)) as Condition] };
        const next: EditableDraft = {
          name: rule.name,
          symbols: [...rule.symbols],
          triggerMode: rule.triggerMode,
          cooldownSec: rule.cooldownSec,
          expression,
          note: rule.note ?? '',
          enabled: rule.enabled,
        };
        setDraft(next);
        setTrialSymbol(next.symbols[0] ?? '');
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [id, templateKey]);

  const previewPayload = useMemo(
    () => ({ ...toPayload(draft), name: draft.name.trim() || '未命名规则', enabled: false }),
    [draft],
  );

  useEffect(() => {
    if (!draft.symbols.length || !draft.expression) {
      setPreview(null);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      setPreviewLoading(true);
      setPreviewError(null);
      api.previewRule(previewPayload)
        .then((result) => {
          if (active) setPreview(result);
        })
        .catch((error: unknown) => {
          if (!active) return;
          setPreview(null);
          setPreviewError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          if (active) setPreviewLoading(false);
        });
    }, 450);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [previewPayload]);

  useEffect(() => {
    if (draft.symbols.length && !draft.symbols.includes(trialSymbol)) {
      setTrialSymbol(draft.symbols[0]);
    }
  }, [draft.symbols, trialSymbol]);

  useEffect(() => {
    if (isEdit || appliedDefaultCooldown.current || !data) return;
    appliedDefaultCooldown.current = true;
    const next = data.settings.defaultCooldownSec;
    if (Number.isFinite(next) && next >= 0) {
      setDraft((previous) =>
        previous.cooldownSec === 300 ? { ...previous, cooldownSec: next } : previous,
      );
    }
  }, [data, isEdit]);

  const conditions = flattenExpression(draft.expression);
  const summary = summarizeExpression(draft.expression);
  const warnings = preview?.warnings ?? [];
  const firstSymbolResult =
    preview?.results.find((result) => result.symbol === draft.symbols[0]) ?? preview?.results[0];
  const previewMap = useMemo(() => {
    const map = new Map<string, ConditionEvaluation>();
    firstSymbolResult?.evaluation?.conditions.forEach((condition) => map.set(condition.conditionId, condition));
    return map;
  }, [firstSymbolResult]);

  function updateDraft(patch: Partial<EditableDraft>) {
    setDraft((previous) => ({ ...previous, ...patch }));
    setSaveErrors([]);
  }

  function applyTemplate(key: string) {
    const next = { ...initialDraft(key), cooldownSec: draft.cooldownSec || 300 };
    setDraft(next);
    setTrialResult(null);
    setTrialSymbol(next.symbols[0] ?? '');
    showToast('已加载模板，请确认条件与品种', 'info');
  }

  async function save() {
    const errors: string[] = [];
    if (draft.name.trim().length < 2 || draft.name.trim().length > 40) errors.push('规则名称需为 2–40 个字符');
    if (!draft.symbols.length) errors.push('至少选择一个交易品种');
    if (!conditions.length) errors.push('至少添加一个条件');
    if (errors.length) {
      setSaveErrors(errors);
      showToast(errors[0], 'error');
      return;
    }
    setSaving(true);
    setSaveErrors([]);
    try {
      if (isEdit && id) await api.updateRule(id, toPayload(draft));
      else await api.createRule(toPayload(draft));
      await refresh();
      showToast(draft.enabled ? '规则已保存并启用，正在建立基线。' : '规则已保存为草稿。', 'success');
      if (!data?.settings.notificationsConfigured) {
        const channel = data?.settings.notificationChannel === 'pushplus' ? '微信 PushPlus' : 'Discord Webhook';
        showToast(`尚未配置${channel}，触发事件只会记录，不会发送。`, 'info');
      }
      navigate('/rules');
    } catch (error) {
      const messages = validationMessages(error);
      setSaveErrors(messages);
      showToast(messages[0] ?? '保存失败', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function openTrial() {
    if (!draft.symbols.length) {
      showToast('请先选择至少一个品种', 'error');
      return;
    }
    setTrialOpen(true);
    setTrialResult(null);
    setTrialError(null);
    setTrialSymbol(draft.symbols.includes(trialSymbol) ? trialSymbol : draft.symbols[0]);
  }

  async function runTrial() {
    setTrialLoading(true);
    setTrialError(null);
    try {
      const result = await api.trialRule({
        ...toPayload(draft),
        name: draft.name.trim() || '未命名规则',
        symbol: trialSymbol,
        windowDays: trialWindow,
      });
      setTrialResult(result);
    } catch (error) {
      setTrialError(validationMessages(error).join('；'));
    } finally {
      setTrialLoading(false);
    }
  }

  async function testPushplusPreview() {
    if (!data?.settings.pushplusConfigured) {
      showToast('请先在设置中配置 PushPlus Token', 'error');
      return;
    }
    try {
      await api.testPushplus();
      showToast('PushPlus 测试消息已受理，请在微信确认', 'success');
    } catch (error) {
      showToast(validationMessages(error).join('；'), 'error');
    }
  }

  async function testDiscordPreview() {
    if (!data?.settings.discordConfigured) {
      showToast('请先在设置中配置 Discord Webhook', 'error');
      return;
    }
    try {
      await api.testDiscord();
      showToast('测试消息已发送到 Discord', 'success');
    } catch (error) {
      showToast(validationMessages(error).join('；'), 'error');
    }
  }

  if (loading) return <LoadingBlock text="正在加载规则…" />;
  if (loadError) return <ErrorBanner message={loadError} onRetry={() => window.location.reload()} />;

  return (
    <div className="page-wrap editor-page">
      <div className="editor-head">
        <div>
          <button type="button" className="back-link" onClick={() => navigate('/rules')}>
            <ArrowLeft size={12} /> 返回规则
          </button>
          <div className="editor-title-line">
            <h1>{isEdit ? '编辑规则' : '新建规则'}</h1>
            <span className="unsaved-pill">尚未保存</span>
          </div>
          <p className="page-sub">
            {conditions.length} 个条件 · {conditions.length ? [...new Set(conditions.map((condition) => condition.timeframe))].join(' + ') : '未设置周期'}
            {isEdit ? ' · 保存修改会重新建立当前状态基线' : ''}
          </p>
        </div>
        <div className="actions">
          <select
            className="template-menu"
            value=""
            onChange={(event) => {
              if (event.target.value) setTemplateConfirm(event.target.value);
            }}
            aria-label="加载模板"
          >
            <option value="">加载模板…</option>
            {RULE_TEMPLATES.map((template) => (
              <option key={template.key} value={template.key}>{template.title}</option>
            ))}
          </select>
          <button type="button" className="btn btn-secondary" onClick={() => void openTrial()}>
            <PlayCircle size={14} /> 试跑
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving} data-testid="save-rule-top">
            {saving ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
            {saving ? '保存中…' : draft.enabled ? '保存并启用' : '保存草稿'}
          </button>
        </div>
      </div>

      {saveErrors.length ? (
        <div className="error-banner" role="alert">
          <div>
            {saveErrors.map((message) => <div key={message}>• {message}</div>)}
          </div>
          <button type="button" onClick={() => setSaveErrors([])}>关闭</button>
        </div>
      ) : null}

      <div className="editor-config">
        <div className="form-grid">
          <div className="form-field span-4">
            <label htmlFor="rule-name">规则名称</label>
            <input
              id="rule-name"
              data-testid="rule-name"
              className="input"
              value={draft.name}
              maxLength={40}
              onChange={(event) => updateDraft({ name: event.target.value })}
              placeholder="例如：15m KDJ J 高位"
            />
          </div>
          <div className="form-field span-4">
            <span className="form-label">适用品种</span>
            <SymbolPicker
              selected={draft.symbols}
              onChange={(symbols) => updateDraft({ symbols })}
              onError={(message) => showToast(message, 'error')}
            />
            <span className="form-hint">每个品种独立判断、独立通知，最多 10 个</span>
          </div>
          <div className="form-field span-2">
            <label htmlFor="trigger-mode">触发时点</label>
            <select
              id="trigger-mode"
              className="select"
              value={draft.triggerMode}
              onChange={(event) => updateDraft({ triggerMode: event.target.value as TriggerMode })}
            >
              <option value="close">收盘确认</option>
              <option value="intrabar">盘中触发</option>
            </select>
          </div>
          <div className="form-field span-2">
            <label htmlFor="cooldown">冷却时间（分钟）</label>
            <input
              id="cooldown"
              className="input input-mono"
              type="number"
              min={0}
              max={1440}
              value={Math.round(draft.cooldownSec / 60)}
              onChange={(event) =>
                updateDraft({
                  cooldownSec: Math.max(0, Math.min(86_400, Number(event.target.value) * 60)),
                })
              }
            />
          </div>
          <div className="form-field span-8">
            <label htmlFor="rule-note">备注（可选，会出现在通知消息中）</label>
            <input
              id="rule-note"
              className="input"
              maxLength={200}
              value={draft.note ?? ''}
              onChange={(event) => updateDraft({ note: event.target.value })}
              placeholder="例如：只做观察，等待收盘确认"
            />
          </div>
          <div className="form-field span-4">
            <span className="form-label">规则状态</span>
            <label className="checkbox-line" style={{ height: 34 }}>
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => updateDraft({ enabled: event.target.checked })}
                data-testid="rule-enabled"
              />
              保存后立即启用监控
            </label>
            <span className="form-hint">当前条件已满足时不会补发历史信号</span>
          </div>
        </div>
        {draft.triggerMode === 'intrabar' ? (
          <div className="warning-banner" style={{ marginTop: 12, marginBottom: 0 }}>
            <TriangleAlert size={13} />
            <div>盘中模式会使用未收盘 K 线，指标可能随价格变化而重绘；触发消息会标记“可能失效”。默认建议使用收盘确认。</div>
          </div>
        ) : null}
      </div>

      <div className="editor-columns">
        <div className="builder-card">
          <div className="builder-head">
            <div className="builder-head-left">
              <Settings2 size={14} color="#7db2aa" />
              条件逻辑
              <span className="muted-small">· {conditions.length} 个条件</span>
            </div>
            <span className="muted-small">同一层条件组使用 AND / OR</span>
          </div>
          <div className="builder-body">
            <div className="builder-note">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 11v5M12 8h.01" />
              </svg>
              <span>
                所有条件都读取各自周期最近一根已收盘 K 线（盘中模式除外）。整条规则由“不满足”变为“满足”时通知一次，持续满足不重复。
              </span>
            </div>
            <RuleBuilder
              expression={draft.expression}
              onChange={(expression) => updateDraft({ expression })}
              preview={previewMap}
            />
            <div className="summary-box">
              <div className="summary-title">
                <ClipboardList size={11} /> 规则摘要
              </div>
              <div className="summary-text">{summary}</div>
              <div className="summary-text" style={{ color: '#657d88', fontSize: 9 }}>
                在 {draft.triggerMode === 'close' ? '已收盘 K 线' : '当前最新 K 线'} 上判断；冷却{' '}
                {draft.cooldownSec === 0 ? '关闭' : `${Math.round(draft.cooldownSec / 60)} 分钟`}。
              </div>
            </div>
            {warnings.length ? (
              <div className="warning-banner" style={{ marginTop: 11, marginBottom: 0 }}>
                <TriangleAlert size={13} />
                <div>{warnings.map((warning) => warning.message).join('；')}</div>
              </div>
            ) : null}
            {previewError ? (
              <div className="warning-banner" style={{ marginTop: 11, marginBottom: 0 }}>
                <TriangleAlert size={13} /> 当前状态暂不可预览：{previewError}
              </div>
            ) : null}
          </div>
          <div className="builder-foot">
            <span>条件值由服务端按同一套指标公式计算，界面与实际触发一致</span>
            <span className="key">最多 12 个条件 / 3 层条件组</span>
          </div>
        </div>

        <div className="side-stack">
          <section className="side-card">
            <div className="side-head">
              <div>
                <div className="side-head-title">当前判断</div>
                <div className="side-head-sub">
                  {firstSymbolResult?.evaluation
                    ? `${firstSymbolResult.symbol} · ${formatDateTime(firstSymbolResult.evaluation.asOf)}`
                    : '等待数据'}
                </div>
              </div>
              {previewLoading ? (
                <Loader2 size={13} className="spin" />
              ) : firstSymbolResult?.evaluation ? (
                <StatusPill tone={firstSymbolResult.evaluation.truth ? 'success' : 'wait'}>
                  {firstSymbolResult.evaluation.truth ? '已满足' : '未满足'}
                </StatusPill>
              ) : (
                <StatusPill tone="off">无数据</StatusPill>
              )}
            </div>
            <div className="status-hero">
              <div>
                <div className="hero-label">整条规则当前状态</div>
                <div className="hero-sub">
                  {firstSymbolResult?.evaluation
                    ? firstSymbolResult.evaluation.truth
                      ? '持续满足不会重复通知，等待重新进入'
                      : '条件尚未全部满足'
                    : previewError ?? '保存并启用后加载数据'}
                </div>
              </div>
              {firstSymbolResult?.evaluation ? (
                <StatusPill tone="info" noDot>{formatPrice(firstSymbolResult.evaluation.price)}</StatusPill>
              ) : null}
            </div>
            <div className="truth-list">
              {conditions.map((condition) => {
                const evaluation = previewMap.get(condition.id);
                return (
                  <div className="judgement-row" key={condition.id}>
                    <span className={`judgement-mark${evaluation?.truth ? ' ok' : ''}`}>{evaluation?.truth ? '✓' : '✕'}</span>
                    <div>
                      <div className="judgement-name">
                        {condition.timeframe} {SERIES_CATALOG[condition.left.series].label} {COMPARATOR_LABEL[condition.cmp]}{' '}
                        {condition.right.type === 'series'
                          ? SERIES_CATALOG[condition.right.series].label
                          : formatNumber(condition.right.value)}
                      </div>
                      <div className="judgement-detail">
                        {evaluation
                          ? `实际 ${formatNumber(evaluation.leftValue)}${evaluation.rightSeries ? ` / ${formatNumber(evaluation.rightValue)}` : ''} · ${formatTime(evaluation.barOpenTime)} K线`
                          : '暂无数据'}
                      </div>
                    </div>
                    <div className={`judgement-value${evaluation?.truth ? '' : ' bad'}`}>
                      {evaluation ? (evaluation.truth ? '满足' : '未满足') : '—'}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="logic-row">
              <span className="lbl">整体表达式</span>
              <span className="val">
                {firstSymbolResult?.evaluation ? (firstSymbolResult.evaluation.truth ? 'true' : 'false') : 'unknown'}
              </span>
            </div>
            <div className="side-note">任一周期数据过期或存在缺口时，整条规则暂停判断，不会用旧值发送信号。</div>
          </section>

          {(data?.settings.notificationChannel ?? 'discord') === 'pushplus' ? (
            <PushplusPreview
              name={draft.name}
              symbols={draft.symbols}
              triggerMode={draft.triggerMode}
              result={firstSymbolResult}
              configured={Boolean(data?.settings.pushplusConfigured)}
              onTest={() => void testPushplusPreview()}
            />
          ) : (
            <DiscordPreview
              name={draft.name}
              symbols={draft.symbols}
              triggerMode={draft.triggerMode}
              cooldownSec={draft.cooldownSec}
              result={firstSymbolResult}
              webhookConfigured={Boolean(data?.settings.discordConfigured)}
              onTest={() => void testDiscordPreview()}
            />
          )}
        </div>
      </div>

      <div className="action-bar">
        <div className="action-bar-note">
          保存修改会重置该规则的当前满足状态并重新建立基线；旧事件不会被改写。
        </div>
        <div className="row">
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/rules')}>取消</button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving} data-testid="save-rule">
            {saving ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
            {saving ? '保存中…' : draft.enabled ? '保存并启用' : '保存草稿'}
          </button>
        </div>
      </div>

      <TrialModal
        open={trialOpen}
        draft={draft}
        symbol={trialSymbol}
        windowDays={trialWindow}
        loading={trialLoading}
        error={trialError}
        result={trialResult}
        onSymbolChange={setTrialSymbol}
        onWindowChange={setTrialWindow}
        onRun={() => void runTrial()}
        onClose={() => setTrialOpen(false)}
      />

      <ConfirmDialog
        open={Boolean(templateConfirm)}
        title="加载模板"
        message="加载模板会替换当前条件组和规则名称，未保存的自定义条件会丢失。继续吗？"
        confirmText="加载模板"
        onConfirm={() => {
          if (templateConfirm) applyTemplate(templateConfirm);
          setTemplateConfirm(null);
        }}
        onCancel={() => setTemplateConfirm(null)}
      />
    </div>
  );
}
