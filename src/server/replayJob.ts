import { randomUUID } from 'node:crypto';
import {
  MIN_HISTORY_BARS,
  TF_MS,
  type ReplayJobView,
  type ReplayPeriod,
  type Rule,
  type Timeframe,
} from '../shared/types';
import type { Store } from './store';
import type { AppMarket } from './market/provider';
import { collectTimeframes, shortestTimeframe } from './rules/schema';
import { runTrial } from './trial';

export const MAX_REPLAY_BARS_PER_TIMEFRAME = 120_000;

export interface ReplayBarEstimate {
  totalBars: number;
  maxBars: number;
  timeframes: { timeframe: Timeframe; bars: number }[];
}

export interface ReplayExecutionParams {
  symbol: string;
  /** Used only when `period` is absent. */
  windowDays: number;
  chartTimeframe: Timeframe;
  period?: ReplayPeriod;
}

function rangeFor(params: ReplayExecutionParams, now: number): { from: number; to: number } {
  if (params.period) return { from: params.period.from, to: Math.min(params.period.to, now) };
  return { from: now - params.windowDays * 86_400_000, to: now };
}

export function estimateReplayBars(rule: Rule, params: ReplayExecutionParams, now = Date.now()): ReplayBarEstimate {
  const signalTimeframe = shortestTimeframe(rule.expression);
  const chartTimeframe = params.chartTimeframe ?? signalTimeframe;
  const timeframes = [...new Set<Timeframe>([
    ...collectTimeframes(rule.expression),
    chartTimeframe,
  ])];
  const range = rangeFor(params, now);
  const entries = timeframes.map((timeframe) => ({
    timeframe,
    bars: Math.max(0, Math.ceil((range.to - range.from) / TF_MS[timeframe]) + MIN_HISTORY_BARS),
  }));
  return {
    totalBars: entries.reduce((sum, item) => sum + item.bars, 0),
    maxBars: entries.reduce((max, item) => Math.max(max, item.bars), 0),
    timeframes: entries,
  };
}

/** Conservative ETA shown while an async replay is processing. */
export function estimateReplaySeconds(rule: Rule, params: ReplayExecutionParams, now = Date.now()): number {
  const signalTimeframe = shortestTimeframe(rule.expression);
  const chartTimeframe = params.chartTimeframe ?? signalTimeframe;
  const estimate = estimateReplayBars(rule, params, now);
  let pages = 0;
  for (const item of estimate.timeframes) pages += Math.ceil(item.bars / 100);
  // OKX's public history endpoint is capped at 100 bars/request and the REST
  // client enforces a 130ms gate plus network/retry overhead.
  return Math.max(8, Math.ceil(pages * 0.32 + 4));
}

export function startReplayJob(options: {
  store: Store;
  market: AppMarket;
  rule: Rule;
  params: ReplayExecutionParams;
  estimatedSeconds: number;
}): ReplayJobView {
  const { store, market, rule, params } = options;
  const id = randomUUID();
  const job = store.createReplayJob({
    id,
    ruleId: rule.id,
    ruleVersion: rule.version,
    params: params as unknown as Record<string, unknown>,
    estimatedSeconds: options.estimatedSeconds,
    createdAt: Date.now(),
  });

  const execute = async (): Promise<void> => {
    try {
      store.markReplayJobProcessing(id, '加载本地优先 K 线');
      const result = await runTrial({
        draft: rule,
        symbol: params.symbol,
        windowDays: params.windowDays,
        chartTimeframe: params.chartTimeframe,
        market,
        store,
        period: params.period,
        // presets such as 1m/30d and 3m/30d are intentionally executed by the
        // async job path, which already batches and limits the page count.
        allowExtendedWindow: true,
      });
      store.markReplayJobProcessing(id, '计算触发与图表');
      const replay = store.saveReplay({
        id: randomUUID(),
        ruleId: rule.id,
        ruleName: rule.name,
        ruleVersion: rule.version,
        symbol: params.symbol,
        windowDays: result.windowDays,
        chartTimeframe: result.timeframe,
        signalTimeframe: result.signalTimeframe,
        result,
        period: result.period,
        createdAt: Date.now(),
      });
      store.completeReplayJob(id, replay.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.failReplayJob(id, message);
    }
  };

  // Let the HTTP request/response finish first; the engine keeps serving while
  // this runs. Jobs are persisted so the UI can poll or recover after reload.
  setTimeout(() => { void execute(); }, 0);
  return job;
}
