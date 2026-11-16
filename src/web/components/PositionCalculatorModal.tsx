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
  { value: 'percent', label: '价格比例（相对开仓价）' },
  { value: 'roi', label: '保证金收益率（净盈亏/本金）' },
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

function exitLabel(reason: string): string {
  return reason === 'target'
    ? '止盈'
    : reason === 'stop'
      ? '止损'
      : reason === 'liquidation'
        ? '强平'
        : reason === 'no-data'
          ? '无后续K线'
          : reason === 'next-signal'
            ? '下一信号'
            : '区间结束';
}

function durationLabel(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours} 小时${minutes ? ` ${minutes} 分` : ''}`;
  return `${minutes} 分${rest ? ` ${rest} 秒` : ''}`;
}

function directionLabel(direction: 'long' | 'short'): string {
  return direction === 'long' ? '做多' : '做空';
}

function priceSeriesOptions(): { key: SeriesKey; label: string }[] {
  return (Object.keys(SERIES_CATALOG) as SeriesKey[])
    .filter((series) => SERIES_CATALOG[series].unit === 'price')
    .map((series) => ({ key: series, label: SERIES_CATALOG[series].label }));
}

function exitSummary(rule: PositionExitRule): string {
  if (rule.mode === 'none') return '不设置';
  if (rule.mode === 'price') return `价格 ${formatNumber(rule.price ?? 0, 2)}`;
  if (rule.mode === 'percent') return `价格比例 ${formatNumber(rule.percent ?? 0, 2)}%`;
  if (rule.mode === 'roi') return `保证金收益率 ${formatNumber(rule.roiPercent ?? 0, 2)}%`;
  return SERIES_CATALOG[rule.series ?? 'price.close']?.label ?? '指标';
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
          {EXIT_MODES.map((mode) => (
            <option key={mode.value} value={mode.value}>{mode.label}</option>
          ))}
        </select>
        {rule.mode === 'price' ? (
          <input className="input" type="number" min="0" step="any" placeholder="价格" value={rule.price ?? ''} onChange={(event) => onChange({ ...rule, price: Number(event.target.value) })} />
        ) : null}
        {rule.mode === 'percent' ? (
          <div className="position-input-suffix">
            <input className="input" type="number" min="0" step="0.1" placeholder="价格比例" value={rule.percent ?? ''} onChange={(event) => onChange({ ...rule, percent: Number(event.target.value) })} />
            <span>%</span>
          </div>
        ) : null}
        {rule.mode === 'roi' ? (
          <div className="position-input-suffix">
            <input className="input" type="number" min="0" step="0.1" placeholder="保证金收益率" value={rule.roiPercent ?? ''} onChange={(event) => onChange({ ...rule, roiPercent: Number(event.target.value) })} />
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
  initialConfig,
  initialCalculation,
  onClose,
}: {
  open: boolean;
  replayId: string;
  result: TrialResult | null;
  selectedIndexes: number[];
  initialConfig?: PositionCalculatorConfig | null;
  initialCalculation?: PositionCalculationResult | null;
  onClose: () => void;
}) {
  const [config, setConfig] = useState<PositionCalculatorConfig>(DEFAULT_CONFIG);
  const [calculation, setCalculation] = useState<PositionCalculationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [calculatedAt, setCalculatedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const options = useMemo(() => priceSeriesOptions(), []);
  const isBatch = selectedIndexes.length > 1;

  useEffect(() => {
    if (!open) return;
    setConfig(initialConfig ?? initialCalculation?.config ?? DEFAULT_CONFIG);
    setCalculation(initialCalculation ?? null);
    setCalculatedAt(initialCalculation ? Date.now() : null);
    setError(null);
    setDirty(false);
  }, [open, selectedIndexes.join(','), replayId, initialConfig, initialCalculation]);

  async function calculate() {
    if (!replayId || !result || !selectedIndexes.length) return;
    const seq = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const { calculation: next } = await api.positionCalc(replayId, config, selectedIndexes);
      if (seq !== requestRef.current) return;
      setCalculation(next);
      setCalculatedAt(Date.now());
      setDirty(false);
    } catch (reason) {
      if (seq !== requestRef.current) return;
      setCalculation(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (seq === requestRef.current) setLoading(false);
    }
  }

  const updateConfig = (next: Partial<PositionCalculatorConfig>) => {
    // Invalidate an in-flight response as soon as any parameter changes.
    requestRef.current++;
    setConfig((previous) => ({ ...previous, ...next }));
    setCalculation(null);
    setCalculatedAt(null);
    setLoading(false);
    setError(null);
    setDirty(true);
  };

  const liquidationDistancePct = config.leverage > 0 ? 100 / config.leverage : null;
  const stopPercent = config.stop.mode === 'percent' && typeof config.stop.percent === 'number' && Number.isFinite(config.stop.percent)
    ? config.stop.percent
    : null;
  const stopRoiPercent = config.stop.mode === 'roi' && typeof config.stop.roiPercent === 'number' && Number.isFinite(config.stop.roiPercent)
    ? config.stop.roiPercent
    : null;
  const effectiveStopMovePct = stopPercent ?? (stopRoiPercent !== null ? stopRoiPercent / config.leverage : null);
  const stopBeyondLiquidation = effectiveStopMovePct !== null
    && liquidationDistancePct !== null
    && effectiveStopMovePct >= liquidationDistancePct;

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
          <label className="form-field">手续费（单边）
            <div className="position-field-unit">
              <input className="input" type="number" min="0" max="10" step="0.01" value={config.feeRatePct} onChange={(event) => updateConfig({ feeRatePct: Number(event.target.value) })} />
              <span>%</span>
            </div>
          </label>
          <label className="form-field">滑点（单边）
            <div className="position-field-unit">
              <input className="input" type="number" min="0" max="10" step="0.01" value={config.slippagePct} onChange={(event) => updateConfig({ slippagePct: Number(event.target.value) })} />
              <span>%</span>
            </div>
          </label>
        </div>

        <div className="position-exits">
          <ExitControl label="止盈（可选）" rule={config.target} options={options} onChange={(target) => updateConfig({ target })} />
          <ExitControl label="止损（可选）" rule={config.stop} options={options} onChange={(stop) => updateConfig({ stop })} />
        </div>

        {liquidationDistancePct !== null ? (
          <div className={`position-risk-hint${stopBeyondLiquidation ? ' danger' : ''}`}>
            <TriangleAlert size={13} />
            <span>
              {config.leverage}x 估算强平距离约 {liquidationDistancePct.toFixed(2)}%（按逐仓、忽略维持保证金与资金费估算）。
              {stopPercent === null && stopRoiPercent === null
                ? ' 未设置百分比止损。'
                : stopRoiPercent !== null
                  ? ` 当前保证金收益率止损 ${stopRoiPercent}% 约对应价格反向 ${effectiveStopMovePct?.toFixed(3)}%；${stopBeyondLiquidation ? '它在强平价之外，实际会先触发强平。' : '它位于估算强平之前，会按净盈亏约 −' + stopRoiPercent + '% 触发。'}`
                  : stopBeyondLiquidation
                    ? ` 当前价格比例止损 ${stopPercent}% 在强平价之外，实际会先触发强平；如需止损先生效，请降低杠杆到约 ${Math.floor(100 / (stopPercent ?? 1))}x 以下，或把止损比例降到约 ${liquidationDistancePct.toFixed(2)}% 以内。`
                    : ` 当前价格比例止损 ${stopPercent}% 位于估算强平之前，止损可以先生效。`}
              {' '}价格比例按价格变动计算；保证金收益率按净盈亏 / 当前这笔仓位的保证金计算。
            </span>
          </div>
        ) : null}

        {options.length === 0 ? (
          <div className="form-hint">当前信号没有可用于止盈/止损的价格类指标；可改用固定价格、价格比例或保证金收益率。</div>
        ) : null}

        <div className="position-calc-actions">
          <button
            type="button"
            className="btn btn-primary"
            data-testid="position-calculate"
            onClick={() => void calculate()}
            disabled={loading || !selectedIndexes.length}
          >
            {loading ? <Loader2 size={13} className="spin" /> : <Calculator size={13} />}
            {loading ? '计算中…' : calculation ? '重新计算' : '开始计算'}
          </button>
          <span className="form-hint">
            {dirty ? '参数已修改，点击开始计算更新结果。' : calculation ? '计算结果基于当前参数。' : '设置本金、方向、杠杆与止盈止损后点击开始计算。'}
          </span>
        </div>

        {error ? <div className="error-banner" role="alert">{error}</div> : null}
        {loading ? <div className="position-loading"><Loader2 size={13} className="spin" /> 正在按信号周期 K 线计算…</div> : null}
        {calculation ? (
          <>
            <div className="position-result-meta" data-testid="position-result-meta">
              计算于 {formatDateTime(calculatedAt ?? Date.now())} · 本金 {formatNumber(calculation.config.capital, 2)} USDT · {directionLabel(calculation.config.direction)} {calculation.config.leverage}x · 止盈：{exitSummary(calculation.config.target)} · 止损：{exitSummary(calculation.config.stop)}
            </div>

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

            {calculation.trades.length === 1 && !isBatch ? (() => {
              const trade = calculation.trades[0];
              return (
                <div className="position-single" data-testid="position-calc-single">
                  <div className="position-single-head"><Calculator size={14} /> 仓位详情</div>
                  <div className="position-single-section">合约与仓位</div>
                  <div className="position-kv"><span>交易品种</span><strong>{trade.symbol || '—'}</strong></div>
                  <div className="position-kv"><span>方向 / 杠杆</span><strong>{directionLabel(trade.direction)} · {trade.leverage}x</strong></div>
                  <div className="position-kv"><span>保证金模式</span><strong>逐仓（OHLC 模拟）</strong></div>
                  <div className="position-kv"><span>开仓时间</span><strong>{formatDateTime(trade.entryAt)}</strong></div>
                  <div className="position-kv"><span>平仓时间</span><strong>{formatDateTime(trade.exitAt)}</strong></div>
                  <div className="position-kv"><span>持仓时长</span><strong>{durationLabel(trade.durationMs)}</strong></div>

                  <div className="position-single-section">价格与数量</div>
                  <div className="position-kv"><span>开仓均价</span><strong>{money(trade.entryPrice)}</strong></div>
                  <div className="position-kv"><span>平仓均价</span><strong>{money(trade.exitPrice)}</strong></div>
                  <div className="position-kv"><span>数量（标的）</span><strong>{formatNumber(trade.quantity, 6)}</strong></div>
                  <div className="position-kv"><span>标记价格 / 订单类型</span><strong>—（已平仓） / 市价（模拟）</strong></div>
                  <div className="position-kv"><span>名义价值</span><strong>{money(trade.notional)} USDT</strong></div>
                  <div className="position-kv"><span>初始保证金</span><strong>{money(trade.initialMargin)} USDT</strong></div>
                  <div className="position-kv"><span>维持保证金 / 资金费</span><strong>{trade.maintenanceMargin === null ? '未计' : money(trade.maintenanceMargin)} / {trade.fundingFee === null ? '未计' : money(trade.fundingFee)}</strong></div>
                  <div className="position-kv"><span>止盈 / 止损 / 估算强平</span><strong>{money(trade.targetPrice)} / {money(trade.stopPrice)} / {money(trade.liquidationPrice)}</strong></div>
                  <div className="position-kv"><span>退出原因</span><strong>{exitLabel(trade.exitReason)}</strong></div>

                  <div className="position-single-section">收益与费用</div>
                  <div className="position-kv"><span>毛盈亏 / 净盈亏</span><strong className={trade.netPnl >= 0 ? 'positive' : 'negative'}>{money(trade.grossPnl)} / {money(trade.netPnl)} USDT</strong></div>
                  <div className="position-kv"><span>开仓 / 平仓手续费</span><strong>{money(trade.openFee)} / {money(trade.closeFee)} USDT</strong></div>
                  <div className="position-kv"><span>总手续费</span><strong>{money(trade.fees)} USDT</strong></div>
                  <div className="position-kv"><span>收益率（保证金）</span><strong className={trade.roiPct >= 0 ? 'positive' : 'negative'}>{pct(trade.roiPct)}</strong></div>
                  <div className="position-kv"><span>名义收益率</span><strong className={trade.pnlOnNotionalPct >= 0 ? 'positive' : 'negative'}>{pct(trade.pnlOnNotionalPct)}</strong></div>
                  <div className="position-kv"><span>盈亏比</span><strong>{trade.riskReward === null ? '—' : `${trade.riskReward.toFixed(2)} : 1`}</strong></div>
                  <div className="position-kv"><span>权益前 / 权益后</span><strong>{money(trade.equityBefore)} → {money(trade.equityAfter)} USDT</strong></div>
                  <div className="position-kv"><span>未实现盈亏 / 保证金率</span><strong>—（已平仓） / 未计</strong></div>
                </div>
              );
            })() : calculation.trades.length ? (

              <div className="position-trade-table">
                <div className="position-trade-head">
                  <span>信号/退出</span><span>方向/杠杆</span><span>开仓时间</span><span>平仓时间</span>
                  <span>开仓价</span><span>平仓价</span><span>数量</span><span>名义</span>
                  <span>手续费</span><span>净盈亏</span><span>收益率</span><span>强平价</span><span>期末权益</span>
                </div>
                {calculation.trades.map((trade) => (
                  <div className="position-trade-row" key={`${trade.index}-${trade.triggerAt}`}>
                    <span className="position-signal-cell">#{trade.index + 1}<small>{exitLabel(trade.exitReason)}</small></span>
                    <span>{directionLabel(trade.direction)} {trade.leverage}x</span>
                    <span>{formatDateTime(trade.entryAt)}</span>
                    <span>{formatDateTime(trade.exitAt)}</span>
                    <span>{money(trade.entryPrice)}</span>
                    <span>{money(trade.exitPrice)}</span>
                    <span>{formatNumber(trade.quantity, 6)}</span>
                    <span>{money(trade.notional)}</span>
                    <span title={`开仓 ${money(trade.openFee)} / 平仓 ${money(trade.closeFee)}`}>{money(trade.fees)}</span>
                    <span className={trade.netPnl >= 0 ? 'positive' : 'negative'}>{money(trade.netPnl)}</span>
                    <span className={trade.roiPct >= 0 ? 'positive' : 'negative'}>{pct(trade.roiPct)}</span>
                    <span>{money(trade.liquidationPrice)}</span>
                    <span>{money(trade.equityAfter)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-table">没有可计算的交易。</div>
            )}

            <div className="position-formula">
              公式：仓位数量 = 本金 × 杠杆 ÷ 开仓价；净收益 = 方向 × (平仓价 − 开仓价) × 数量 − 开仓/平仓双边手续费。开仓与平仓均计入配置滑点；同一根 K 线同时碰到止盈止损按止损优先；跳空按开盘价成交；未设置止盈止损时按回放区间最后一根收盘价估算；估算强平忽略维持保证金与资金费率，手续费按配置单边费率计。批量模式按信号时间顺序保持单仓位复利：若下一选中信号在当前持仓止盈/止损前出现，会跳过该信号，不平仓，也不会在之后补开仓。
            </div>
          </>
        ) : !loading && !error ? <div className="empty-table">设置参数后点击“开始计算”。</div> : null}
      </div>
    </Modal>
  );
}
