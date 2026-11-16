import {
  type ConditionEvaluation,
  type Rule,
  type RuleDraft,
  type ReplayPeriod,
  type Timeframe,
  type TrialResult,
  MIN_HISTORY_BARS,
  TF_MS,
  normalizeParams,
  type IndicatorParams,
} from '../shared/types';
import type { Candle } from '../shared/types';
import type { AppMarket } from './market/provider';
import type { Store } from './store';
import { compareValues, computeSeries, type Series } from './indicators';
import { collectTimeframes, evaluateExpression, flattenConditions, shortestTimeframe } from './rules/schema';
import { loadLocalFirstHistory, type HistoryLoad } from './history';
import { isUsMarketTradingDay } from './usMarketCalendar';
import { isWithinDailyWindow } from './replayPeriod';

export class TrialError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'TrialError';
    this.statusCode = statusCode;
  }
}

interface HistorySet {
  timeframe: Timeframe;
  candles: Candle[];
  closeTimes: number[];
}

interface PreparedCondition {
  conditionIndex: number;
  timeframe: Timeframe;
  left: Series;
  right: Series | number;
  leftParams: IndicatorParams;
  rightParams: IndicatorParams | null;
}

function maxWindowDays(timeframes: Timeframe[]): number {
  if (timeframes.includes('1m')) return 7;
  if (timeframes.includes('3m')) return 14;
  return 30;
}

function clampWindow(days: number, maxDays: number): number {
  if (!Number.isFinite(days)) return Math.min(7, maxDays);
  return Math.max(1, Math.min(maxDays, Math.round(days)));
}

function formatNumber(value: number): number {
  return Number(value.toFixed(10));
}

export async function runTrial(options: {
  draft: RuleDraft;
  symbol: string;
  windowDays: number;
  chartTimeframe?: Timeframe;
  market: AppMarket;
  store?: Store;
  now?: number;
  /** Exact date range + optional daily time window for custom replay. */
  period?: ReplayPeriod;
  /** Replay/trial UIs that batch history may honor >7d/14d windows. */
  allowExtendedWindow?: boolean;
}): Promise<TrialResult> {
  const { draft, market } = options;
  const ruleTimeframes = collectTimeframes(draft.expression);
  const referenceTimeframe = shortestTimeframe(draft.expression);
  const chartTimeframe = options.chartTimeframe ?? referenceTimeframe;
  const requestedTimeframes = [...new Set<Timeframe>([...ruleTimeframes, chartTimeframe])];
  if (!draft.symbols.includes(options.symbol)) throw new TrialError('试跑品种不在规则范围内');
  const maxDays = maxWindowDays(requestedTimeframes);
  const allowedMaxDays = options.allowExtendedWindow ? 30 : maxDays;
  const marketNow = options.now ?? market.exchangeNow();
  const period = options.period;
  const windowStart = period ? period.from : marketNow - clampWindow(options.windowDays, allowedMaxDays) * 86_400_000;
  const windowEnd = period ? Math.min(period.to, marketNow) : marketNow;
  if (windowEnd <= windowStart) throw new TrialError('回放结束时间必须晚于开始时间');
  const windowDays = period
    ? Math.max(0.01, Number(((windowEnd - windowStart) / 86_400_000).toFixed(3)))
    : clampWindow(options.windowDays, allowedMaxDays);
  const warnings: string[] = [];
  if (!period && !options.allowExtendedWindow && windowDays !== options.windowDays) {
    warnings.push(`该周期组合最多试跑 ${maxDays} 天，已自动缩短窗口`);
  }
  if (period) {
    warnings.push(`自定义回放：${period.allDay ? '全天' : `${String(Math.floor(period.dailyStartMinute / 60)).padStart(2, '0')}:${String(period.dailyStartMinute % 60).padStart(2, '0')}–${String(Math.floor(period.dailyEndMinute / 60)).padStart(2, '0')}:${String(period.dailyEndMinute % 60).padStart(2, '0')}`}（${period.timezone}），信号仅在所选时段内生成`);
  }
  if (draft.triggerMode === 'intrabar') {
    warnings.push('历史盘中 tick 无法还原，试跑按收盘确认口径计算');
  }
  if (chartTimeframe !== referenceTimeframe) {
    warnings.push(`图表周期为 ${chartTimeframe}，规则评估周期为 ${referenceTimeframe}`);
  }
  if (draft.skipUsNonTradingDays) {
    warnings.push('已过滤美股非交易日（周末 + NYSE/Nasdaq 全休市日）');
  }

  const historyLoads = new Map<Timeframe, HistoryLoad>();
  const historyEntries = await Promise.all(
    requestedTimeframes.map(async (timeframe) => {
      const warmupFrom = windowStart - MIN_HISTORY_BARS * TF_MS[timeframe];
      const loaded = options.store
        ? await loadLocalFirstHistory({
            store: options.store,
            market,
            instId: options.symbol,
            timeframe,
            from: warmupFrom,
            to: windowEnd,
            strictRange: Boolean(period),
            maxPages: Math.max(140, Math.ceil((windowEnd - warmupFrom) / TF_MS[timeframe] / 100) + 16),
          })
        : {
            candles: await market.fetchHistory(options.symbol, timeframe, warmupFrom, windowEnd),
            source: 'remote' as const,
            localBars: 0,
            fetchedBars: 0,
            coverage: 1,
            gaps: 0,
            from: warmupFrom,
            to: windowEnd,
            requestedFrom: warmupFrom,
            requestedTo: windowEnd,
          };
      const closed = loaded.candles
        .filter((candle) => candle.confirm)
        .filter((candle) => candle.openTime + TF_MS[timeframe] <= windowEnd)
        .sort((a, b) => a.openTime - b.openTime);
      historyLoads.set(timeframe, {
        ...loaded,
        candles: closed,
        fetchedBars: loaded.fetchedBars || (loaded.source === 'remote' ? closed.length : 0),
      });
      return { timeframe, candles: closed, closeTimes: closed.map((candle) => candle.openTime + TF_MS[timeframe]) };
    }),
  );
  const histories = new Map<Timeframe, HistorySet>(historyEntries.map((entry) => [entry.timeframe, entry]));
  for (const timeframe of ruleTimeframes) {
    const history = histories.get(timeframe);
    if (!history || history.candles.length < MIN_HISTORY_BARS) {
      throw new TrialError(`${options.symbol} ${timeframe} 历史数据不足（${history?.candles.length ?? 0}/${MIN_HISTORY_BARS}），请缩短窗口或稍后重试`, 422);
    }
  }
  if (!histories.get(chartTimeframe)?.candles.length) {
    throw new TrialError(`${options.symbol} ${chartTimeframe} 图表周期没有可用历史数据`, 422);
  }

  const loads = [...historyLoads.values()];
  const dataInfo: TrialResult['data'] = {
    source: loads.some((item) => item.source === 'remote' || item.source === 'local+remote')
      ? (loads.some((item) => item.source === 'local' || item.source === 'local+remote') ? 'local+remote' : 'remote')
      : 'local',
    localBars: loads.reduce((sum, item) => sum + item.localBars, 0),
    fetchedBars: loads.reduce((sum, item) => sum + item.fetchedBars, 0),
    coverage: loads.length ? Number(Math.min(...loads.map((item) => item.coverage)).toFixed(6)) : 0,
    gaps: loads.reduce((sum, item) => sum + item.gaps, 0),
    from: Math.min(...loads.map((item) => item.from)),
    to: Math.max(...loads.map((item) => item.to)),
  };
  if (dataInfo.coverage < 0.999 || dataInfo.gaps > 0) {
    warnings.push(`历史数据覆盖 ${(dataInfo.coverage * 100).toFixed(1)}%，仅能回放实际可用的连续区间`);
  }

  const conditions = flattenConditions(draft.expression);
  const prepared: PreparedCondition[] = conditions.map((condition, conditionIndex) => {
    const history = histories.get(condition.timeframe)!;
    const leftParams = normalizeParams(condition.left.series, condition.left.params);
    const left = computeSeries(history.candles, condition.left.series, leftParams);
    let right: Series | number;
    let rightParams: IndicatorParams | null = null;
    if (condition.right.type === 'number') {
      right = condition.right.value;
    } else {
      rightParams = normalizeParams(condition.right.series, condition.right.params);
      right = computeSeries(history.candles, condition.right.series, rightParams);
    }
    return { conditionIndex, timeframe: condition.timeframe, left, right, leftParams, rightParams };
  });

  const referenceHistory = histories.get(referenceTimeframe)!;
  const allEventTimes = new Set<number>();
  for (const timeframe of ruleTimeframes) {
    const history = histories.get(timeframe)!;
    for (const closeTime of history.closeTimes) {
      if (closeTime > windowStart && closeTime <= windowEnd) allEventTimes.add(closeTime);
    }
  }
  // Sampling every higher timeframe close is enough for a close-confirmed trial.
  const eventTimes = [...allEventTimes].sort((a, b) => a - b);
  const pointers = new Map<Timeframe, number>();
  for (const timeframe of requestedTimeframes) pointers.set(timeframe, -1);

  const evaluateAt = (time: number): { evaluation: ConditionEvaluation[]; truth: boolean } | null => {
    const snapshots: ConditionEvaluation[] = [];
    for (const [timeframe, history] of histories) {
      let pointer = pointers.get(timeframe)!;
      while (pointer + 1 < history.closeTimes.length && history.closeTimes[pointer + 1] <= time) pointer++;
      pointers.set(timeframe, pointer);
    }
    for (const item of prepared) {
      const history = histories.get(item.timeframe)!;
      const index = pointers.get(item.timeframe)!;
      if (index < MIN_HISTORY_BARS - 1) return null;
      const leftValue = item.left[index];
      const rightValue = typeof item.right === 'number' ? item.right : item.right[index];
      if (leftValue === null || leftValue === undefined || rightValue === null || rightValue === undefined) return null;
      const condition = conditions[item.conditionIndex];
      const bar = history.candles[index];
      snapshots.push({
        conditionId: condition.id,
        timeframe: condition.timeframe,
        leftSeries: condition.left.series,
        rightSeries: condition.right.type === 'series' ? condition.right.series : null,
        leftValue,
        rightValue,
        cmp: condition.cmp,
        truth: compareValues(leftValue, condition.cmp, rightValue),
        barOpenTime: bar.openTime,
        barCloseTime: bar.openTime + TF_MS[condition.timeframe],
        leftParams: item.leftParams,
        rightParams: item.rightParams,
      });
    }
    const truthById = new Map(snapshots.map((snapshot) => [snapshot.conditionId, snapshot.truth]));
    return { evaluation: snapshots, truth: evaluateExpression(draft.expression, truthById) };
  };

  // Establish the state at the very start of the window without counting it.
  const baseline = evaluateAt(windowStart);
  let previousTruth = baseline?.truth ?? false;
  let baselineReady = Boolean(baseline);
  let lastTriggerAt: number | null = null;
  let triggerCount = 0;
  const triggers: TrialResult['triggers'] = [];

  for (const eventTime of eventTimes) {
    const result = evaluateAt(eventTime);
    if (!result) continue;
    if (!baselineReady) {
      previousTruth = result.truth;
      baselineReady = true;
      continue;
    }
    if (!previousTruth && result.truth) {
      const usMarketAllowed = !draft.skipUsNonTradingDays || isUsMarketTradingDay(eventTime);
      const dailyWindowAllowed = !period || isWithinDailyWindow(eventTime, period);
      if (usMarketAllowed && dailyWindowAllowed) {
        const cooldownMs = draft.cooldownSec * 1000;
        if (lastTriggerAt === null || eventTime - lastTriggerAt >= cooldownMs) {
          triggerCount++;
          if (triggers.length < 500) {
            const refIndex = pointers.get(referenceTimeframe)!;
            const referenceBar = referenceHistory.candles[refIndex];
            triggers.push({
              triggerAt: eventTime,
              barOpenTime: referenceBar.openTime,
              barCloseTime: referenceBar.openTime + TF_MS[referenceTimeframe],
              price: referenceBar.close,
              triggerMode: draft.triggerMode,
              conditions: result.evaluation,
              truth: result.truth,
              alreadyMatched: false,
              markerType: 'trigger',
            });
          }
          lastTriggerAt = eventTime;
        }
      }
    }
    previousTruth = result.truth;
  }

  const chartHistory = histories.get(chartTimeframe)!;
  const chartCandlesAll = chartHistory.candles.filter(
    (candle) => candle.openTime + TF_MS[chartTimeframe] > windowStart && candle.openTime < windowEnd,
  );
  // Keep the whole replay window so every listed trigger has a candle to anchor to.
  // Valid windows top out around 10k 1m bars / 8.6k 5m bars.
  const chartCandles = chartCandlesAll.slice(-12_000);
  if (chartCandlesAll.length > chartCandles.length) {
    warnings.push(`图表仅展示最近 ${chartCandles.length} 根 ${chartTimeframe} K 线；更早的触发仍保留在清单中`);
  }
  const boll = computeSeries(
    chartCandles,
    'bb.upper',
    normalizeParams('bb.upper', { length: 20, mult: 2 }),
  );
  const middle = computeSeries(
    chartCandles,
    'bb.middle',
    normalizeParams('bb.middle', { length: 20, mult: 2 }),
  );
  const lower = computeSeries(
    chartCandles,
    'bb.lower',
    normalizeParams('bb.lower', { length: 20, mult: 2 }),
  );

  return {
    triggerCount,
    perDay: Number((triggerCount / windowDays).toFixed(2)),
    windowDays,
    symbol: options.symbol,
    timeframe: chartTimeframe,
    signalTimeframe: referenceTimeframe,
    data: dataInfo,
    period,
    triggers,
    triggersTruncated: triggerCount > triggers.length,
    candles: chartCandles.map((candle) => ({
      openTime: candle.openTime,
      open: formatNumber(candle.open),
      high: formatNumber(candle.high),
      low: formatNumber(candle.low),
      close: formatNumber(candle.close),
      volume: formatNumber(candle.volume),
    })),
    indicators: {
      upper: boll.map((value) => (value === null ? null : formatNumber(value))),
      middle: middle.map((value) => (value === null ? null : formatNumber(value))),
      lower: lower.map((value) => (value === null ? null : formatNumber(value))),
    },
    warning: warnings.length ? warnings.join('；') : '仅统计规则触发次数，不计算盈亏，不代表策略有效性。',
  };
}
