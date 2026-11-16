import { useEffect, useMemo, useRef, useState } from 'react';
import { Calculator, Loader2, TriangleAlert } from 'lucide-react';
import {
  SERIES_CATALOG,
  type PositionCalculatorConfig,
  type PositionCalculationResult,
  type PositionExitMode,
  type PositionExitRule,
  type SeriesKey,
  type TrialResult,
} from '../../shared/types';
import { api } from '../api';
import { formatDateTime, formatNumber } from '../lib/format';
import { Modal } from './ui';

const DEFAULT_CONFIG: PositionCalculatorConfig = {
  direction: 'long',
  capital: 1_000,
  leverage: 1,
  feeRatePct: 0.05,
  slippagePct: 0.02,
  target: { mode: 'none' },
  stop: { mode: 'none' },
};

const EXIT_MODES: { value: PositionExitMode; label: string }[] = [
  { value: 'none', label: '不设置' },
  { value: 'price', label: '固定价格' },
  { value: 'percent', label: '固定比例' },
  { value: 'indicator', label: '指标值' },
];

function money(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return formatNumber(value, 2);
}

function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}%`;
}

function priceSeriesOptions(): { key: SeriesKey; label: string }[] {
  return (Object.keys(SERIES_CATALOG) as SeriesKey[])
    .filter((series) => SERIES_CATALOG[series].unit === 'price')
    .map((series) => ({ key: series, label: SERIES_CATALOG[series].label }));
}


function ExitControl({
  label,
  rule,
  options,
  onChange,
}: {
  label: string;
  rule: PositionExitRule;
  options: { key: SeriesKey; label: string }[];
  onChange: (rule: PositionExitRule) => void;
}) {
  return (
    <div className="position-exit-control">
      <label className="form-label">{label}</label>
      <div className="position-exit-row">
        <select className="select" value={rule.mode} onChange={(event) => {
          const mode = event.target.value as PositionExitMode;
          onChange({
            mode,
            ...(mode === 'indicator' && options[0] ? { series: options[0].key } : {}),
          });
        }}>
          {EXIT_MODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
        </select>
        {rule.mode === 'price' ? (
          <input className="input" type="number" min="0" step="any" placeholder="价格" value={rule.price ?? ''} onChange={(event) => onChange({ ...rule, price: Number(event.target.value) })} />
        ) : null}
        {rule.mode === 'percent' ? (
          <div className="position-input-suffix">
            <input className="input" type="number" min="0" step="0.1" placeholder="比例" value={rule.percent ?? ''} onChange={(event) => onChange({ ...rule, percent: Number(event.target.value) })} />
            <span>%</span>
          </div>
        ) : null}
        {rule.mode === 'indicator' ? (
          <select className="select" value={rule.series ?? ''} onChange={(event) => onChange({ ...rule, series: event.target.value as SeriesKey })}>
            <option value="">选择指标</option>
            {options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
          </select>
        ) : null}
      </div>
    </div>
  );
}

export function PositionCalculatorModal({
  open,
  replayId,
  result,
  selectedIndexes,
  onClose,
}: {
  open: boolean;
  replayId: string;
  result: TrialResult | null;
  selectedIndexes: number[];
  onClose: () => void;
}) {
  const [config, setConfig] = useState<PositionCalculatorConfig>(DEFAULT_CONFIG);
  const [calculation, setCalculation] = useState<PositionCalculationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const options = useMemo(() => priceSeriesOptions(), []);
  const isBatch = selectedIndexes.length > 1;

  useEffect(() => {
    if (!open) return;
    setCalculation(null);
    setError(null);
  }, [open, selectedIndexes.join(','), replayId]);

  useEffect(() => {
    if (!open || !replayId || !result || !selectedIndexes.length) return;
    let active = true;
    const timer = window.setTimeout(() => {
      const seq = ++requestRef.current;
      setLoading(true);
      setError(null);
      api.positionCalc(replayId, config, selectedIndexes)
        .then(({ calculation: next }) => {
          if (active && seq === requestRef.current) setCalculation(next);
        })
        .catch((reason: unknown) => {
          if (!active || seq !== requestRef.current) return;
          setCalculation(null);
          setError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => {
          if (active && seq === requestRef.current) setLoading(false);
        });
    }, 280);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [open, replayId, result, selectedIndexes.join(','), config]);

  const updateConfig = (next: Partial<PositionCalculatorConfig>) => {
    setConfig((previous) => ({ ...previous, ...next }));
  };

  return (
    <Modal
      open={open}
      title={isBatch ? `批量复利计算 · ${selectedIndexes.length} 个信号` : '仓位计算'}
      subtitle="以信号 K 线收盘价为开仓参考，使用信号周期后续 K 线模拟止盈/止损；所有金额以 USDT 计价。"
      onClose={onClose}
      wide
      footer={<button type="button" className="btn btn-secondary" onClick={onClose}>关闭</button>}
    >
      <div className="position-calculator" data-testid="position-calculator">
        <div className="position-config-grid">
          <label className="form-field">本金（USDT）
            <input className="input" type="number" min="0" step="0.01" value={config.capital} onChange={(event) => updateConfig({ capital: Number(event.target.value) })} />
          </label>
          <label className="form-field">方向
            <select className="select" value={config.direction} onChange={(event) => updateConfig({ direction: event.target.value as PositionCalculatorConfig['direction'] })}>
              <option value="long">做多</option>
              <option value="short">做空</option>
            </select>
          </label>
          <label className="form-field">杠杆倍数
            <input className="input" type="number" min="1" max="125" step="1" value={config.leverage} onChange={(event) => updateConfig({ leverage: Number(event.target.value) })} />
            <span className="form-hint">默认 1x；杠杆越高，止损前被强平的距离越近</span>
          </label>
          <label className="form-field">手续费（%/单边）
            <input className="input" type="number" min="0" max="10" step="0.01" value={config.feeRatePct} onChange={(event) => updateConfig({ feeRatePct: Number(event.target.value) })} />
          </label>
          <label className="form-field">滑点（%/单边）
            <input className="input" type="number" min="0" max="10" step="0.01" value={config.slippagePct} onChange={(event) => updateConfig({ slippagePct: Number(event.target.value) })} />
          </label>
        </div>

        <div className="position-exits">
          <ExitControl label="止盈（可选）" rule={config.target} options={options} onChange={(target) => updateConfig({ target })} />
          <ExitControl label="止损（可选）" rule={config.stop} options={options} onChange={(stop) => updateConfig({ stop })} />
        </div>

        {options.length === 0 ? (
          <div className="form-hint">当前信号没有可用于止盈/止损的价格类指标；可改用固定价格或固定比例。</div>
        ) : null}

        {error ? <div className="error-banner" role="alert">{error}</div> : null}
        {loading ? <div className="position-loading"><Loader2 size={13} className="spin" /> 正在按信号周期 K 线计算…</div> : null}
        {calculation ? (
          <>
            <div className="position-summary" data-testid="position-calc-summary">
              <div><span>交易笔数</span><strong>{calculation.trades.length}</strong></div>
              <div><span>期末权益</span><strong>{money(calculation.finalEquity)} USDT</strong></div>
              <div><span>总收益</span><strong className={calculation.totalNetPnl >= 0 ? 'positive' : 'negative'}>{money(calculation.totalNetPnl)} USDT</strong></div>
              <div><span>总收益率</span><strong className={calculation.totalReturnPct >= 0 ? 'positive' : 'negative'}>{pct(calculation.totalReturnPct)}</strong></div>
              <div><span>最大回撤</span><strong>{calculation.maxDrawdownPct.toFixed(2)}%</strong></div>
            </div>

            {calculation.warnings.length ? (
              <div className="warning-banner"><TriangleAlert size={13} /><div>{calculation.warnings.join('；')}</div></div>
            ) : null}

            {isBatch && calculation.skipped.length ? (
              <div className="position-skipped">跳过 {calculation.skipped.length} 条：{calculation.skipped.map((item) => `#${item.index + 1}${item.reason === 'overlap' ? '（重叠）' : '（权益不足）'}`).join('、')}</div>
            ) : null}

            {calculation.trades.length === 1 && !isBatch ? (
              <div className="position-single" data-testid="position-calc-single">
                <div className="position-single-head"><Calculator size={14} /> 单笔结果</div>
                <div className="position-kv"><span>开仓 / 平仓</span><strong>{money(calculation.trades[0].entryPrice)} → {money(calculation.trades[0].exitPrice)}</strong></div>
                <div className="position-kv"><span>数量 / 名义仓位</span><strong>{formatNumber(calculation.trades[0].quantity, 6)} / {money(calculation.trades[0].notional)} USDT</strong></div>
                <div className="position-kv"><span>退出原因</span><strong>{calculation.trades[0].exitReason === 'target' ? '止盈' : calculation.trades[0].exitReason === 'stop' ? '止损' : calculation.trades[0].exitReason === 'liquidation' ? '强平' : calculation.trades[0].exitReason === 'no-data' ? '无后续K线' : '区间结束'}</strong></div>
                <div className="position-kv"><span>毛盈亏 / 手续费</span><strong>{money(calculation.trades[0].grossPnl)} / {money(calculation.trades[0].fees)} USDT</strong></div>
                <div className="position-kv"><span>净盈亏 / 收益率</span><strong className={calculation.trades[0].netPnl >= 0 ? 'positive' : 'negative'}>{money(calculation.trades[0].netPnl)} USDT / {pct(calculation.trades[0].roiPct)}</strong></div>
                <div className="position-kv"><span>止盈 / 止损 / 估算强平</span><strong>{money(calculation.trades[0].targetPrice)} / {money(calculation.trades[0].stopPrice)} / {money(calculation.trades[0].liquidationPrice)}</strong></div>
                <div className="position-kv"><span>盈亏比</span><strong>{calculation.trades[0].riskReward === null ? '—' : `${calculation.trades[0].riskReward.toFixed(2)} : 1`}</strong></div>
                <div className="position-kv"><span>平仓时间</span><strong>{formatDateTime(calculation.trades[0].exitAt)}</strong></div>
              </div>
            ) : calculation.trades.length ? (
              <div className="position-trade-table">
                <div className="position-trade-head"><span>信号</span><span>开仓</span><span>平仓</span><span>退出</span><span>盈亏比</span><span>净盈亏</span><span>期末权益</span></div>
                {calculation.trades.map((trade) => (
                  <div className="position-trade-row" key={`${trade.index}-${trade.triggerAt}`}>
                    <span>#{trade.index + 1}</span>
                    <span>{money(trade.entryPrice)}</span>
                    <span>{money(trade.exitPrice)}</span>
                    <span>{trade.exitReason === 'target' ? '止盈' : trade.exitReason === 'stop' ? '止损' : trade.exitReason === 'liquidation' ? '强平' : trade.exitReason === 'no-data' ? '无K线' : '结束'}</span>
                    <span>{trade.riskReward === null ? '—' : `${trade.riskReward.toFixed(2)}`}</span>
                    <span className={trade.netPnl >= 0 ? 'positive' : 'negative'}>{money(trade.netPnl)}</span>
                    <span>{money(trade.equityAfter)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-table">没有可计算的交易。</div>
            )}

            <div className="position-formula">
              公式：仓位数量 = 本金 × 杠杆 ÷ 开仓价；净收益 = 方向 × (平仓价 − 开仓价) × 数量 − 开仓/平仓双边手续费。开仓与平仓均计入配置滑点；同一根 K 线同时碰到止盈止损按止损优先；跳空按开盘价成交；未设置止盈止损时按回放区间最后一根收盘价估算；估算强平忽略维持保证金与资金费率，手续费按配置单边费率计。批量模式按信号时间顺序对全部选中信号逐笔复利；存在重叠持仓时属于理论顺序收益，不模拟同时占用保证金。
            </div>
          </>
        ) : !loading && !error ? <div className="empty-table">等待计算…</div> : null}
      </div>
    </Modal>
  );
}
