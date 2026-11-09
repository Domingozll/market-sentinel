import { useMemo } from 'react';
import { Loader2, PlayCircle, TriangleAlert } from 'lucide-react';
import type { Candle, RuleDraft, TrialResult } from '../../shared/types';
import { ErrorBanner, LoadingBlock, Modal } from './ui';
import { MarketChart } from './MarketChart';
import { formatDateTime, formatPrice } from '../lib/format';

export function TrialModal({
  open,
  draft,
  symbol,
  windowDays,
  loading,
  error,
  result,
  onSymbolChange,
  onWindowChange,
  onRun,
  onClose,
}: {
  open: boolean;
  draft: RuleDraft;
  symbol: string;
  windowDays: number;
  loading: boolean;
  error: string | null;
  result: TrialResult | null;
  onSymbolChange: (symbol: string) => void;
  onWindowChange: (days: number) => void;
  onRun: () => void;
  onClose: () => void;
}) {
  const chartCandles = useMemo<Candle[]>(() => {
    if (!result) return [];
    return result.candles.map((candle) => ({
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
    }));
  }, [result]);
  const markers = useMemo(
    () => result?.triggers.map((trigger) => ({ triggerAt: trigger.triggerAt, price: trigger.price, label: '触发' })) ?? [],
    [result],
  );
  return (
    <Modal
      open={open}
      title="规则试跑"
      subtitle="使用历史已收盘 K 线模拟规则触发；不计算盈亏，也不会发送 Discord 消息。"
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>关闭</button>
          <button type="button" className="btn btn-primary" onClick={onRun} disabled={loading || !draft.symbols.length} data-testid="run-trial">
            {loading ? <Loader2 size={14} className="spin" /> : <PlayCircle size={14} />}
            {loading ? '试跑中…' : '运行试跑'}
          </button>
        </>
      }
    >
      <div className="form-grid" style={{ marginBottom: 12 }}>
        <div className="form-field span-6">
          <label className="form-label">试跑品种</label>
          <select className="select" value={symbol} onChange={(event) => onSymbolChange(event.target.value)}>
            {draft.symbols.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </div>
        <div className="form-field span-6">
          <span className="form-label">回看窗口</span>
          <div className="row">
            {[7, 30].map((days) => (
              <button
                key={days}
                type="button"
                className={`btn ${windowDays === days ? 'btn-primary' : 'btn-secondary'} btn-sm`}
                onClick={() => onWindowChange(days)}
              >
                最近 {days} 天
              </button>
            ))}
            <span className="form-hint">1m 周期最多 7 天；服务端会自动缩短超限窗口。</span>
          </div>
        </div>
      </div>
      {error ? <ErrorBanner message={error} /> : null}
      {loading ? <LoadingBlock text="正在拉取历史 K 线并回放条件…" /> : null}
      {result ? (
        <>
          <div className="trial-metrics">
            <div className="trial-metric"><div className="k">触发次数</div><div className="v">{result.triggerCount}<small>次</small></div></div>
            <div className="trial-metric"><div className="k">平均每天</div><div className="v">{result.perDay}<small>次/天</small></div></div>
            <div className="trial-metric"><div className="k">回看窗口</div><div className="v">{result.windowDays}<small>天</small></div></div>
          </div>
          <div className="warning-banner"><TriangleAlert size={13} /><div>{result.warning}</div></div>
          <MarketChart
            candles={chartCandles}
            timeframe={result.timeframe}
            markers={markers}
            height={270}
            compact
          />
          <div className="muted-small" style={{ marginTop: 6, marginBottom: 5 }}>
            图表展示 {result.symbol} 最近的 {chartCandles.length} 根 {result.timeframe} K 线，触发标记仅对应此范围内的信号。
          </div>
          <div className="trial-list">
            {result.triggers.length === 0 ? (
              <div className="empty-table">窗口内没有触发。可以放宽条件或缩短冷却后再试。</div>
            ) : result.triggers.slice(0, 50).map((trigger, index) => (
              <div className="trial-row" key={`${trigger.triggerAt}-${index}`}>
                <span className="time">{formatDateTime(trigger.triggerAt)}</span>
                <span className="price">{formatPrice(trigger.price)}</span>
              </div>
            ))}
          </div>
        </>
      ) : !loading ? (
        <div className="empty-state" style={{ padding: '24px 20px' }}>
          <div className="es-title">运行一次规则试跑</div>
          <div className="es-desc">确认触发频率和条件表现。试跑结果只代表历史收盘信号，不构成策略或收益验证。</div>
        </div>
      ) : null}
    </Modal>
  );
}
