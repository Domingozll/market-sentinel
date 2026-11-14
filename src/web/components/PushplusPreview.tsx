import {
  COMPARATOR_LABEL,
  SERIES_CATALOG,
  TRIGGER_MODE_LABEL,
  type RuleEvaluation,
  type TriggerMode,
} from '../../shared/types';
import { formatDateTime, formatNumber, formatPrice } from '../lib/format';

export function PushplusPreview({
  name,
  symbols,
  triggerMode,
  result,
  configured,
  onTest,
}: {
  name: string;
  symbols: string[];
  triggerMode: TriggerMode;
  result:
    | {
        symbol: string;
        ok: boolean;
        evaluation?: RuleEvaluation;
        reason?: string;
        message?: string;
      }
    | undefined;
  configured: boolean;
  onTest: () => void;
}) {
  const evaluation = result?.evaluation;
  const firstSymbol = symbols[0] ?? '—';
  const timeframes = [...new Set(evaluation?.conditions.map((condition) => condition.timeframe) ?? [])].join(' / ') || '—';
  return (
    <section className="side-card pushplus-preview" data-testid="pushplus-preview">
      <div className="side-head">
        <div>
          <div className="side-head-title">PushPlus 消息预览</div>
          <div className="side-head-sub">
            {configured ? '触发后发送到已配置的微信 PushPlus' : '尚未配置 PushPlus Token，仅记录事件'}
          </div>
        </div>
        <div className="pp-mini" aria-hidden="true">微信</div>
      </div>
      <div className="pp-wrap">
        <div className="pp-message">
          <div className="pp-chat-head">
            <span className="pp-logo">推</span>
            <span>PushPlus</span>
            <time>触发时</time>
          </div>
          <div className="pp-bubble">
            <div className="pp-title">行情哨兵 · {triggerMode === 'intrabar' ? '盘中触发' : '触发'} · {firstSymbol}</div>
            <div className="pp-meta">{name || '未命名规则'} · {timeframes}</div>
            <div className="pp-line"><span>触发时间</span><b>{evaluation ? formatDateTime(evaluation.asOf) : '触发时生成'}</b></div>
            <div className="pp-line"><span>触发价</span><b className="up">{evaluation ? formatPrice(evaluation.price) : '—'}</b></div>
            <div className="pp-line"><span>触发模式</span><b>{TRIGGER_MODE_LABEL[triggerMode]}</b></div>
            <div className="pp-conditions">
              <div className="pp-conditions-head">条件快照</div>
              {evaluation ? (
                evaluation.conditions.map((condition) => (
                  <div className="pp-cond" key={condition.conditionId}>
                    <span className={condition.truth ? 'ok' : 'no'}>{condition.truth ? '✓' : '✕'}</span>
                    <span>
                      {condition.timeframe} {SERIES_CATALOG[condition.leftSeries].label}{' '}
                      <b>{formatNumber(condition.leftValue)}</b> {COMPARATOR_LABEL[condition.cmp]}{' '}
                      {condition.rightSeries ? SERIES_CATALOG[condition.rightSeries].label : formatNumber(condition.rightValue)}
                    </span>
                  </div>
                ))
              ) : (
                <div className="pp-cond empty">保存并启用后显示当前条件值</div>
              )}
            </div>
            <div className="pp-foot"><span>事件 ID · 触发后生成</span><span>仅提醒，不构成投资建议</span></div>
          </div>
        </div>
        <div className="dc-actions">
          <span>{configured ? '测试消息不会写入正式事件流' : '请先在设置中配置 PushPlus Token'}</span>
          <button type="button" data-testid="pushplus-preview-test" onClick={onTest} disabled={!configured}>发送测试 →</button>
        </div>
      </div>
    </section>
  );
}
