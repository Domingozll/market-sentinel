import { COMPARATOR_LABEL, SERIES_CATALOG, TRIGGER_MODE_LABEL, type RuleEvaluation, type TriggerMode } from '../../shared/types';
import { formatDateTime, formatNumber, formatPrice } from '../lib/format';

export function DiscordPreview({
  name,
  symbols,
  triggerMode,
  cooldownSec,
  result,
  webhookConfigured,
  onTest,
}: {
  name: string;
  symbols: string[];
  triggerMode: TriggerMode;
  cooldownSec: number;
  result:
    | {
        symbol: string;
        ok: boolean;
        evaluation?: RuleEvaluation;
        reason?: string;
        message?: string;
      }
    | undefined;
  webhookConfigured: boolean;
  onTest: () => void;
}) {
  const evaluation = result?.evaluation;
  const firstSymbol = symbols[0] ?? '—';
  return (
    <section className="side-card" data-testid="discord-preview">
      <div className="side-head">
        <div>
          <div className="side-head-title">Discord 消息预览</div>
          <div className="side-head-sub">{webhookConfigured ? '触发后发送到已配置的 Webhook' : '尚未配置 Webhook，仅记录事件'}</div>
        </div>
        <div className="discord-mini" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M18.9 5.1A16 16 0 0 0 15 4l-.5 1a14.7 14.7 0 0 0-5 0L9 4a16 16 0 0 0-3.9 1.1C2.5 8.9 1.8 12.7 2.2 16.4A16.4 16.4 0 0 0 7.2 19l1-1.4a10 10 0 0 1-1.6-.8l.4-.3a11.7 11.7 0 0 0 10 0l.4.3c-.5.3-1 .6-1.6.8l1 1.4a16.4 16.4 0 0 0 5-2.6c.5-4.3-.6-8-2.9-11.3ZM8.6 14.3c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Zm6.8 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Z" />
          </svg>
        </div>
      </div>
      <div className="dc-wrap">
        <div className="discord-message">
          <div className="dc-accent" />
          <div className="dc-content">
            <div className="dc-app">
              <span className="badge">APP</span> 行情哨兵 <time>触发时</time>
            </div>
            <div className="dc-title">{triggerMode === 'intrabar' ? '📡 盘中触发' : '📡 触发'} · {firstSymbol}</div>
            <div className="dc-sub">
              {name || '未命名规则'} · {[...new Set(evaluation?.conditions.map((condition) => condition.timeframe) ?? [])].join(' / ') || '—'}
            </div>
            <div className="dc-fields">
              <div className="dc-field"><div className="k">触发时间</div><div className="v">{evaluation ? formatDateTime(evaluation.asOf) : '触发时生成'}</div></div>
              <div className="dc-field"><div className="k">触发价</div><div className="v up">{evaluation ? formatPrice(evaluation.price) : '—'}</div></div>
              <div className="dc-field"><div className="k">触发模式</div><div className="v">{TRIGGER_MODE_LABEL[triggerMode]}</div></div>
              <div className="dc-field"><div className="k">冷却</div><div className="v">{cooldownSec === 0 ? '无' : `${Math.round(cooldownSec / 60)} 分钟`}</div></div>
            </div>
            <div className="dc-rule-box">
              <div className="dc-rule-head">条件快照</div>
              {evaluation ? (
                evaluation.conditions.map((condition) => (
                  <div className="dc-cond" key={condition.conditionId}>
                    <span className={condition.truth ? 'ok' : 'no'}>{condition.truth ? '✓' : '✕'}</span>
                    {condition.timeframe} {SERIES_CATALOG[condition.leftSeries].label}{' '}
                    <b>{formatNumber(condition.leftValue)}</b> {COMPARATOR_LABEL[condition.cmp]}{' '}
                    {condition.rightSeries ? SERIES_CATALOG[condition.rightSeries].label : formatNumber(condition.rightValue)}
                  </div>
                ))
              ) : (
                <div className="dc-cond" style={{ color: '#6b8090' }}>保存并启用后显示当前条件值</div>
              )}
            </div>
            <div className="dc-footer">
              <span>事件 ID · 触发后生成</span>
              <span>仅提醒，不构成投资建议</span>
            </div>
          </div>
        </div>
        <div className="dc-actions">
          <span>{webhookConfigured ? '测试消息不会写入正式事件流' : '请先在设置中配置 Webhook'}</span>
          <button type="button" onClick={onTest} disabled={!webhookConfigured}>发送测试 →</button>
        </div>
      </div>
    </section>
  );
}
