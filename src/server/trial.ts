import {
  type ConditionEvaluation,
  type Rule,
  type RuleDraft,
  type Timeframe,
  type TrialResult,
  MIN_HISTORY_BARS,
  TF_MS,
  normalizeParams,
  type IndicatorParams,
} from '../shared/types';
import type { Candle } from '../shared/types';
import type { AppMarket } from './market/provider';
import { compareValues, computeSeries, type Series } from './indicators';
import { collectTimeframes, evaluateExpression, flattenConditions, shortestTimeframe } from './rules/schema';

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
  market: AppMarket;
  now?: number;
}): Promise<TrialResult> {
  const { draft, market } = options;
  const timeframes = collectTimeframes(draft.expression);
  if (!draft.symbols.includes(options.symbol)) throw new TrialError('试跑品种不在规则范围内');
  const maxDays = maxWindowDays(timeframes);
  const windowDays = clampWindow(options.windowDays, maxDays);
  const now = options.now ?? market.exchangeNow();
  const windowStart = now - windowDays * 86_400_000;
  const warnings: string[] = [];
  if (windowDays !== options.windowDays) {
    warnings.push(`该周期组合最多试跑 ${maxDays} 天，已自动缩短窗口`);
  }
  if (draft.triggerMode === 'intrabar') {
    warnings.push('历史盘中 tick 无法还原，试跑按收盘确认口径计算');
  }

  const historyEntries = await Promise.all(
    timeframes.map(async (timeframe) => {
      const warmupFrom = windowStart - MIN_HISTORY_BARS * TF_MS[timeframe];
      const candles = await market.fetchHistory(options.symbol, timeframe, warmupFrom, now);
      const closed = candles
        .filter((candle) => candle.confirm)
        .filter((candle) => candle.openTime + TF_MS[timeframe] <= now)
        .sort((a, b) => a.openTime - b.openTime);
      return { timeframe, candles: closed, closeTimes: closed.map((candle) => candle.openTime + TF_MS[timeframe]) };
    }),
  );
  const histories = new Map<Timeframe, HistorySet>(historyEntries.map((entry) => [entry.timeframe, entry]));
  for (const [timeframe, history] of histories) {
    if (history.candles.length < MIN_HISTORY_BARS) {
      throw new TrialError(`${options.symbol} ${timeframe} 历史数据不足（${history.candles.length}/${MIN_HISTORY_BARS}），请缩短窗口或稍后重试`, 422);
    }
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

  const referenceTimeframe = shortestTimeframe(draft.expression);
  const referenceHistory = histories.get(referenceTimeframe)!;
  const allEventTimes = new Set<number>();
  for (const history of histories.values()) {
    for (const closeTime of history.closeTimes) {
      if (closeTime > windowStart && closeTime <= now) allEventTimes.add(closeTime);
    }
  }
  // Sampling every higher timeframe close is enough for a close-confirmed trial.
  const eventTimes = [...allEventTimes].sort((a, b) => a - b);
  const pointers = new Map<Timeframe, number>();
  for (const timeframe of timeframes) pointers.set(timeframe, -1);

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
      const cooldownMs = draft.cooldownSec * 1000;
      if (lastTriggerAt === null || eventTime - lastTriggerAt >= cooldownMs) {
        triggerCount++;
        if (triggers.length < 500) {
          const refIndex = pointers.get(referenceTimeframe)!;
          const referenceBar = referenceHistory.candles[refIndex];
          triggers.push({
            triggerAt: eventTime,
            price: referenceBar.close,
            conditions: result.evaluation,
            truth: result.truth,
            alreadyMatched: false,
            markerType: 'trigger',
          });
        }
        lastTriggerAt = eventTime;
      }
    }
    previousTruth = result.truth;
  }

  const chartCandlesAll = referenceHistory.candles.filter(
    (candle) => candle.openTime + TF_MS[referenceTimeframe] > windowStart && candle.openTime < now,
  );
  const chartCandles = chartCandlesAll.slice(-480);
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
    timeframe: referenceTimeframe,
    triggers,
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
