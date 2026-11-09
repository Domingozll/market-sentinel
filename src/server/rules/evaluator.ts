import {
  type ConditionEvaluation,
  type Rule,
  type RuleEvaluation,
  type Timeframe,
  TF_MS,
  SERIES_CATALOG,
  normalizeParams,
  type SeriesKey,
  type IndicatorParams,
} from '../../shared/types';
import { MIN_HISTORY_BARS } from '../../shared/types';
import type { Candle } from '../../shared/types';
import type { Series } from '../indicators';
import { compareValues, computeSeries } from '../indicators';
import type { MarketDataProvider } from '../market/provider';
import { collectTimeframes } from './schema';
import { evaluateExpression, flattenConditions } from './schema';
import { isLatestClosedBarFresh } from '../market/time';

export type EvaluationFailureReason = 'history' | 'stale' | 'gap' | 'indicator' | 'price' | 'no_data';

export type EvaluationOutcome =
  | { ok: true; evaluation: RuleEvaluation }
  | { ok: false; reason: EvaluationFailureReason; message: string; timeframe?: Timeframe };

interface TimeframeData {
  timeframe: Timeframe;
  allCandles: Candle[];
  barIndex: number;
  bar: Candle;
  closedLatest: Candle;
}

function seriesCacheKey(series: SeriesKey, params: IndicatorParams): string {
  return `${series}|${JSON.stringify(normalizeParams(series, params))}`;
}

/**
 * Evaluates a rule for one symbol against the provider's current bars.
 * This function has no side effects and is used by both live monitoring and preview.
 */
export function evaluateRule(
  rule: Rule,
  symbol: string,
  provider: MarketDataProvider,
  now = provider.exchangeNow(),
  forceClosed = false,
): EvaluationOutcome {
  const timeframes = collectTimeframes(rule.expression);
  const dataByTimeframe = new Map<Timeframe, TimeframeData>();

  for (const timeframe of timeframes) {
    const closed = provider.getClosedCandles(symbol, timeframe, 320);
    if (closed.length < MIN_HISTORY_BARS) {
      return {
        ok: false,
        reason: 'history',
        message: `${symbol} ${timeframe} 预热数据不足（${closed.length}/${MIN_HISTORY_BARS}）`,
        timeframe,
      };
    }
    const latestClosed = closed[closed.length - 1];
    if (!isLatestClosedBarFresh(latestClosed, now)) {
      return {
        ok: false,
        reason: 'stale',
        message: `${symbol} ${timeframe} 最近收盘 K 线不新鲜`,
        timeframe,
      };
    }
    if (!provider.hasContinuousHistory(symbol, timeframe)) {
      return {
        ok: false,
        reason: 'gap',
        message: `${symbol} ${timeframe} 回看窗口存在缺口`,
        timeframe,
      };
    }
    let allCandles = closed;
    if (rule.triggerMode === 'intrabar' && !forceClosed) {
      const includingForming = provider.getCandlesIncludingForming(symbol, timeframe, 320);
      const last = includingForming[includingForming.length - 1];
      if (last && !last.confirm) allCandles = includingForming;
    }
    const bar = allCandles[allCandles.length - 1];
    if (!bar) {
      return { ok: false, reason: 'no_data', message: `${symbol} ${timeframe} 没有可用 K 线`, timeframe };
    }
    dataByTimeframe.set(timeframe, {
      timeframe,
      allCandles,
      barIndex: allCandles.length - 1,
      bar,
      closedLatest: latestClosed,
    });
  }

  const seriesCache = new Map<string, Series>();
  const getSeries = (series: SeriesKey, params: IndicatorParams, timeframe: Timeframe): Series => {
    const key = `${timeframe}|${seriesCacheKey(series, params)}`;
    let computed = seriesCache.get(key);
    if (!computed) {
      const data = dataByTimeframe.get(timeframe)!;
      computed = computeSeries(data.allCandles, series, params);
      seriesCache.set(key, computed);
    }
    return computed;
  };

  const conditions: ConditionEvaluation[] = [];
  for (const condition of flattenConditions(rule.expression)) {
    const data = dataByTimeframe.get(condition.timeframe)!;
    const index = data.barIndex;
    const leftParams = normalizeParams(condition.left.series, condition.left.params);
    const leftSeries = getSeries(condition.left.series, leftParams, condition.timeframe);
    const leftValue = leftSeries[index] ?? null;
    let rightValue: number | null;
    let rightSeries: SeriesKey | null = null;
    let rightParams: IndicatorParams | null = null;
    if (condition.right.type === 'number') {
      rightValue = condition.right.value;
    } else {
      rightSeries = condition.right.series;
      rightParams = normalizeParams(condition.right.series, condition.right.params);
      const series = getSeries(rightSeries, rightParams, condition.timeframe);
      rightValue = series[index] ?? null;
    }
    if (leftValue === null || rightValue === null) {
      return {
        ok: false,
        reason: 'indicator',
        message: `条件 ${condition.id} 的指标值不可用（预热不足或空值）`,
        timeframe: condition.timeframe,
      };
    }
    const truth = compareValues(leftValue, condition.cmp, rightValue);
    conditions.push({
      conditionId: condition.id,
      timeframe: condition.timeframe,
      leftSeries: condition.left.series,
      rightSeries,
      leftValue,
      rightValue,
      cmp: condition.cmp,
      truth,
      barOpenTime: data.bar.openTime,
      barCloseTime: data.bar.openTime + TF_MS[condition.timeframe],
      leftParams,
      rightParams,
    });
  }

  const truthById = new Map(conditions.map((condition) => [condition.conditionId, condition.truth]));
  const truth = evaluateExpression(rule.expression, truthById);
  const referenceTimeframe = timeframes
    .slice()
    .sort((a, b) => TF_MS[a] - TF_MS[b])[0] ?? '5m';
  const reference = dataByTimeframe.get(referenceTimeframe);
  if (!reference) {
    return { ok: false, reason: 'no_data', message: '缺少参考周期数据' };
  }
  if (!Number.isFinite(reference.bar.close) || reference.bar.close <= 0) {
    return { ok: false, reason: 'price', message: `${symbol} 收盘价不可用`, timeframe: referenceTimeframe };
  }

  const evaluation: RuleEvaluation = {
    symbol,
    truth,
    conditions,
    price: reference.bar.close,
    triggerBarTs: reference.bar.openTime,
    triggerBarCloseTs: reference.bar.openTime + TF_MS[referenceTimeframe],
    referenceTimeframe,
    asOf: now,
  };
  return { ok: true, evaluation };
}

export function conditionLabel(condition: ConditionEvaluation): string {
  const left = SERIES_CATALOG[condition.leftSeries].label;
  if (condition.rightSeries) {
    const right = SERIES_CATALOG[condition.rightSeries].label;
    return `${condition.timeframe} ${left} ${cmpLabel(condition.cmp)} ${right}`;
  }
  return `${condition.timeframe} ${left} ${cmpLabel(condition.cmp)} ${condition.rightValue}`;
}

function cmpLabel(cmp: ConditionEvaluation['cmp']): string {
  return { gt: '>', gte: '≥', lt: '<', lte: '≤' }[cmp];
}
