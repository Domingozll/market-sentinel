import {
  SERIES_CATALOG,
  type Candle,
  type PositionCalculationResult,
  type PositionCalculatorConfig,
  type PositionExitReason,
  type PositionExitRule,
  type PositionSkipped,
  type PositionTradeResult,
  type TrialTrigger,
} from '../shared/types';

export class PositionCalcError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'PositionCalcError';
  }
}

interface ResolvedTrade {
  targetPrice: number | null;
  stopPrice: number | null;
  liquidationPrice: number;
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function validatePositionConfig(config: PositionCalculatorConfig): void {
  if (config.direction !== 'long' && config.direction !== 'short') {
    throw new PositionCalcError('方向必须是 long 或 short');
  }
  if (!isFinitePositive(config.capital) || config.capital > 1_000_000_000_000) {
    throw new PositionCalcError('本金必须是大于 0 的有限数字');
  }
  if (!Number.isInteger(config.leverage) || config.leverage < 1 || config.leverage > 125) {
    throw new PositionCalcError('杠杆倍数必须是 1–125 的整数');
  }
  if (!Number.isFinite(config.feeRatePct) || config.feeRatePct < 0 || config.feeRatePct > 10) {
    throw new PositionCalcError('手续费率必须在 0–10% 之间（单边）');
  }
  if (!Number.isFinite(config.slippagePct) || config.slippagePct < 0 || config.slippagePct > 10) {
    throw new PositionCalcError('滑点必须在 0–10% 之间（单边）');
  }
  for (const [name, rule] of [['止盈', config.target], ['止损', config.stop]] as const) {
    if (!['none', 'price', 'percent', 'indicator'].includes(rule.mode)) {
      throw new PositionCalcError(`${name}方式不合法`);
    }
    if (rule.mode === 'price' && (!isFinitePositive(rule.price) || rule.price <= 0)) {
      throw new PositionCalcError(`${name}固定价格必须是大于 0 的有限数字`);
    }
    if (rule.mode === 'percent' && (!isFinitePositive(rule.percent) || rule.percent > 1000)) {
      throw new PositionCalcError(`${name}比例必须在 0–1000% 之间`);
    }
    if (rule.mode === 'indicator' && (!rule.series || !SERIES_CATALOG[rule.series] || SERIES_CATALOG[rule.series].unit !== 'price')) {
      throw new PositionCalcError(`${name}指标必须是价格类指标`);
    }
  }
}

function indicatorValue(trigger: TrialTrigger, series: string): number | null {
  for (const condition of trigger.conditions) {
    if (condition.leftSeries === series && condition.leftValue !== null && Number.isFinite(condition.leftValue)) {
      return condition.leftValue;
    }
    if (condition.rightSeries === series && condition.rightValue !== null && Number.isFinite(condition.rightValue)) {
      return condition.rightValue;
    }
  }
  return null;
}

function resolveExit(
  mode: PositionExitRule['mode'],
  rule: PositionExitRule,
  entry: number,
  direction: 'long' | 'short',
  trigger: TrialTrigger,
  label: string,
  side: 'target' | 'stop',
): number | null {
  if (mode === 'none') return null;
  if (mode === 'price') return rule.price ?? null;
  if (mode === 'percent') {
    const delta = entry * ((rule.percent ?? 0) / 100);
    const favorable = direction === 'long' ? entry + delta : entry - delta;
    const adverse = direction === 'long' ? entry - delta : entry + delta;
    return side === 'target' ? favorable : adverse;
  }
  const value = indicatorValue(trigger, rule.series ?? '');
  if (value === null) throw new PositionCalcError(`第 ${trigger.triggerAt} 个信号没有 ${label}指标 ${rule.series} 的可用值`);
  return value;
}

function exitWithSlippage(raw: number, direction: 'long' | 'short', slippagePct: number): number {
  const slip = slippagePct / 100;
  return direction === 'long' ? raw * (1 - slip) : raw * (1 + slip);
}

function entryWithSlippage(raw: number, direction: 'long' | 'short', slippagePct: number): number {
  const slip = slippagePct / 100;
  return direction === 'long' ? raw * (1 + slip) : raw * (1 - slip);
}

function feeAmount(quantity: number, price: number, feeRatePct: number): number {
  return quantity * price * (feeRatePct / 100);
}

function plannedNet(
  quantity: number,
  entry: number,
  rawExit: number,
  direction: 'long' | 'short',
  config: PositionCalculatorConfig,
): number {
  const exit = exitWithSlippage(rawExit, direction, config.slippagePct);
  const gross = direction === 'long' ? (exit - entry) * quantity : (entry - exit) * quantity;
  return gross - feeAmount(quantity, entry, config.feeRatePct) - feeAmount(quantity, exit, config.feeRatePct);
}

function resolveTradeLevels(
  trigger: TrialTrigger,
  entry: number,
  config: PositionCalculatorConfig,
): ResolvedTrade {
  const direction = config.direction;
  const targetPrice = resolveExit(config.target.mode, config.target, entry, direction, trigger, '止盈', 'target');
  const stopPrice = resolveExit(config.stop.mode, config.stop, entry, direction, trigger, '止损', 'stop');
  if (targetPrice !== null) {
    if (direction === 'long' ? targetPrice <= entry : targetPrice >= entry) {
      throw new PositionCalcError(`止盈价 ${targetPrice} 不在 ${direction === 'long' ? '开仓价上方' : '开仓价下方'}（信号 #${trigger.triggerAt}）`);
    }
  }
  if (stopPrice !== null) {
    if (direction === 'long' ? stopPrice >= entry : stopPrice <= entry) {
      throw new PositionCalcError(`止损价 ${stopPrice} 不在 ${direction === 'long' ? '开仓价下方' : '开仓价上方'}（信号 #${trigger.triggerAt}）`);
    }
  }
  const liquidationPrice = direction === 'long'
    ? entry * (1 - 1 / config.leverage)
    : entry * (1 + 1 / config.leverage);
  return { targetPrice, stopPrice, liquidationPrice };
}

function simulateTrade(
  trigger: TrialTrigger,
  candles: Candle[],
  config: PositionCalculatorConfig,
  timeframeMs: number,
  endTime: number,
  equityBefore: number,
): PositionTradeResult {
  const direction = config.direction;
  const entryAt = trigger.barCloseTime > 0 ? trigger.barCloseTime : trigger.triggerAt;
  const entryPrice = entryWithSlippage(trigger.price, direction, config.slippagePct);
  if (!isFinitePositive(entryPrice)) throw new PositionCalcError('信号价格不合法');
  const quantity = (equityBefore * config.leverage) / entryPrice;
  if (!Number.isFinite(quantity) || quantity <= 0) throw new PositionCalcError('仓位数量计算失败');
  const levels = resolveTradeLevels(trigger, entryPrice, config);
  const { targetPrice, stopPrice, liquidationPrice } = levels;

  const plannedTargetPnl = targetPrice === null ? null : plannedNet(quantity, entryPrice, targetPrice, direction, config);
  const plannedStopPnl = stopPrice === null ? null : plannedNet(quantity, entryPrice, stopPrice, direction, config);
  const riskReward = plannedTargetPnl !== null && plannedStopPnl !== null && plannedStopPnl < 0
    ? plannedTargetPnl / Math.abs(plannedStopPnl)
    : null;

  const future = candles
    .filter((candle) => candle.openTime >= entryAt && candle.openTime + timeframeMs <= endTime)
    .sort((a, b) => a.openTime - b.openTime);

  let rawExit: number | null = null;
  let exitAt = entryAt;
  let reason: PositionExitReason = 'no-data';

  // Determine which adverse level is closer. A stop beyond liquidation would
  // never fill: liquidation occurs first.
  const stopIsCloser = stopPrice !== null && (
    direction === 'long' ? stopPrice > liquidationPrice : stopPrice < liquidationPrice
  );

  for (const candle of future) {
    if (direction === 'long') {
      if (stopIsCloser && stopPrice !== null) {
        if (candle.open <= stopPrice) { rawExit = candle.open; exitAt = candle.openTime + timeframeMs; reason = 'stop'; break; }
        if (candle.low <= stopPrice) { rawExit = stopPrice; exitAt = candle.openTime + timeframeMs; reason = 'stop'; break; }
      }
      if (candle.open <= liquidationPrice) { rawExit = candle.open; exitAt = candle.openTime + timeframeMs; reason = 'liquidation'; break; }
      if (candle.low <= liquidationPrice) { rawExit = liquidationPrice; exitAt = candle.openTime + timeframeMs; reason = 'liquidation'; break; }
      if (!stopIsCloser && stopPrice !== null) {
        if (candle.open <= stopPrice) { rawExit = candle.open; exitAt = candle.openTime + timeframeMs; reason = 'stop'; break; }
        if (candle.low <= stopPrice) { rawExit = stopPrice; exitAt = candle.openTime + timeframeMs; reason = 'stop'; break; }
      }
      if (targetPrice !== null) {
        if (candle.open >= targetPrice) { rawExit = candle.open; exitAt = candle.openTime + timeframeMs; reason = 'target'; break; }
        if (candle.high >= targetPrice) { rawExit = targetPrice; exitAt = candle.openTime + timeframeMs; reason = 'target'; break; }
      }
    } else {
      if (stopIsCloser && stopPrice !== null) {
        if (candle.open >= stopPrice) { rawExit = candle.open; exitAt = candle.openTime + timeframeMs; reason = 'stop'; break; }
        if (candle.high >= stopPrice) { rawExit = stopPrice; exitAt = candle.openTime + timeframeMs; reason = 'stop'; break; }
      }
      if (candle.open >= liquidationPrice) { rawExit = candle.open; exitAt = candle.openTime + timeframeMs; reason = 'liquidation'; break; }
      if (candle.high >= liquidationPrice) { rawExit = liquidationPrice; exitAt = candle.openTime + timeframeMs; reason = 'liquidation'; break; }
      if (!stopIsCloser && stopPrice !== null) {
        if (candle.open >= stopPrice) { rawExit = candle.open; exitAt = candle.openTime + timeframeMs; reason = 'stop'; break; }
        if (candle.high >= stopPrice) { rawExit = stopPrice; exitAt = candle.openTime + timeframeMs; reason = 'stop'; break; }
      }
      if (targetPrice !== null) {
        if (candle.open <= targetPrice) { rawExit = candle.open; exitAt = candle.openTime + timeframeMs; reason = 'target'; break; }
        if (candle.low <= targetPrice) { rawExit = targetPrice; exitAt = candle.openTime + timeframeMs; reason = 'target'; break; }
      }
    }
  }

  if (rawExit === null) {
    const last = future[future.length - 1];
    if (last) {
      rawExit = last.close;
      exitAt = last.openTime + timeframeMs;
      reason = 'end';
    } else {
      rawExit = trigger.price;
      exitAt = entryAt;
      reason = 'no-data';
    }
  }

  const exitPrice = exitWithSlippage(rawExit, direction, config.slippagePct);
  const grossPnl = direction === 'long' ? (exitPrice - entryPrice) * quantity : (entryPrice - exitPrice) * quantity;
  const fees = feeAmount(quantity, entryPrice, config.feeRatePct) + feeAmount(quantity, exitPrice, config.feeRatePct);
  let netPnl = grossPnl - fees;
  let equityAfter = equityBefore + netPnl;
  if (equityAfter < 0) {
    // Isolated margin cannot lose more than the allocated capital.
    equityAfter = 0;
    netPnl = -equityBefore;
  }
  return {
    index: 0,
    triggerAt: trigger.triggerAt,
    entryAt,
    entryPrice,
    quantity,
    notional: quantity * entryPrice,
    exitAt,
    exitPrice,
    exitReason: reason,
    targetPrice,
    stopPrice,
    plannedTargetPnl,
    plannedStopPnl,
    riskReward,
    liquidationPrice,
    grossPnl,
    fees,
    netPnl,
    roiPct: (netPnl / equityBefore) * 100,
    equityBefore,
    equityAfter,
  };
}

export function calculatePositions(options: {
  triggers: TrialTrigger[];
  triggerIndexes: number[];
  candles: Candle[];
  timeframeMs: number;
  endTime: number;
  config: PositionCalculatorConfig;
}): PositionCalculationResult {
  const { triggers, candles, config } = options;
  validatePositionConfig(config);
  const indexes = [...new Set(options.triggerIndexes)];
  if (!indexes.length) throw new PositionCalcError('请至少选择一个信号点');
  for (const index of indexes) {
    if (!Number.isInteger(index) || index < 0 || index >= triggers.length) {
      throw new PositionCalcError(`信号序号不合法：${index}`);
    }
  }
  const selected = indexes
    .map((index) => ({ index, trigger: triggers[index] }))
    .sort((a, b) => a.trigger.triggerAt - b.trigger.triggerAt || a.index - b.index);

  let equity = config.capital;
  let availableAt = 0;
  const trades: PositionTradeResult[] = [];
  const skipped: PositionSkipped[] = [];
  const warnings: string[] = [];

  for (const item of selected) {
    if (equity <= 0) {
      skipped.push({ index: item.index, triggerAt: item.trigger.triggerAt, reason: 'insufficient-equity' });
      continue;
    }
    if (item.trigger.triggerAt < availableAt) {
      skipped.push({ index: item.index, triggerAt: item.trigger.triggerAt, reason: 'overlap' });
      continue;
    }
    const trade = simulateTrade(item.trigger, candles, config, options.timeframeMs, options.endTime, equity);
    trade.index = item.index;
    trades.push(trade);
    equity = trade.equityAfter;
    availableAt = trade.exitAt;
    if (trade.exitReason === 'liquidation') warnings.push(`#${item.index + 1} 触发估算强平，收益按保证金上限截断`);
    if (trade.exitReason === 'no-data') warnings.push(`#${item.index + 1} 之后没有可用 K 线，按开仓价退出`);
  }

  if (skipped.some((item) => item.reason === 'overlap')) {
    warnings.push('批量复利按信号时间顺序执行；与上一笔持仓重叠的信号已跳过，避免用同一笔保证金重复开仓。');
  }
  if (skipped.some((item) => item.reason === 'insufficient-equity')) {
    warnings.push('权益已归零，后续信号不再开仓。');
  }

  let runningPeak = config.capital;
  let maxDrawdown = 0;
  for (const trade of trades) {
    runningPeak = Math.max(runningPeak, trade.equityAfter);
    if (runningPeak > 0) maxDrawdown = Math.max(maxDrawdown, (runningPeak - trade.equityAfter) / runningPeak);
  }

  const totalNetPnl = equity - config.capital;
  return {
    config,
    triggerIndexes: indexes,
    trades,
    skipped,
    initialCapital: config.capital,
    finalEquity: equity,
    totalNetPnl,
    totalReturnPct: (totalNetPnl / config.capital) * 100,
    maxDrawdownPct: maxDrawdown * 100,
    warnings,
  };
}
