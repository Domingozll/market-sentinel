import { TF_MS, type Candle, type Timeframe, type TrialDataInfo } from '../shared/types';
import type { Store } from './store';
import type { AppMarket } from './market/provider';

export class HistoryError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 422) {
    super(message);
    this.name = 'HistoryError';
    this.statusCode = statusCode;
  }
}

export interface HistoryLoad extends TrialDataInfo {
  candles: Candle[];
  requestedFrom: number;
  requestedTo: number;
}

interface Gap {
  from: number;
  to: number;
}

function missingRuns(candles: Candle[], start: number, last: number, tfMs: number): Gap[] {
  const present = new Set(candles.map((candle) => candle.openTime));
  const runs: Gap[] = [];
  let gapStart: number | null = null;
  for (let openTime = start; openTime <= last; openTime += tfMs) {
    if (!present.has(openTime)) {
      if (gapStart === null) gapStart = openTime;
    } else if (gapStart !== null) {
      runs.push({ from: gapStart, to: openTime - tfMs });
      gapStart = null;
    }
  }
  if (gapStart !== null) runs.push({ from: gapStart, to: last });
  return runs;
}

function confirmedInRange(candles: Candle[], from: number, to: number): Candle[] {
  return candles
    .filter((candle) => candle.confirm && candle.openTime >= from && candle.openTime <= to)
    .sort((a, b) => a.openTime - b.openTime);
}

/**
 * Local-first historical candle loader.
 *
 * The invariant is strict: return a contiguous sequence of confirmed candles
 * for every expected open time. If a contiguous local range exists no network
 * request is made. Missing runs are fetched from the exchange, persisted, and
 * verified before the caller is allowed to evaluate a rule.
 */
export async function loadLocalFirstHistory(options: {
  store: Store;
  market: AppMarket;
  instId: string;
  timeframe: Timeframe;
  from: number;
  to: number;
  /** Throw if any expected candle is still missing after incremental fetching. */
  strictRange?: boolean;
  /** Maximum OKX history pages; the REST client enforces its own request interval. */
  maxPages?: number;
}): Promise<HistoryLoad> {
  const { store, market, instId, timeframe, to } = options;
  const tfMs = TF_MS[timeframe];
  const start = Math.floor(options.from / tfMs) * tfMs;
  // Last candle whose close is at or before `to`.
  const last = Math.floor((to - tfMs) / tfMs) * tfMs;
  const maxPages = options.maxPages ?? Math.max(140, Math.ceil((last - start) / tfMs / 100) + 8);
  if (last < start) {
    return {
      candles: [],
      localBars: 0,
      fetchedBars: 0,
      coverage: 0,
      gaps: 0,
      source: 'local',
      from: start,
      to: last,
      requestedFrom: options.from,
      requestedTo: options.to,
    };
  }

  let local = store.getCandleRange(instId, timeframe, start, last);
  const localBefore = local.length;
  let fetchedBars = 0;
  const fetchErrors: string[] = [];
  let gaps = missingRuns(local, start, last, tfMs);

  if (gaps.length) {
    const fetchGap = async (gap: Gap): Promise<number> => {
      const remote = await market.fetchHistory(instId, timeframe, gap.from, gap.to + tfMs, maxPages);
      const confirmed = confirmedInRange(remote, gap.from, gap.to);
      if (!confirmed.length) return 0;
      store.upsertCandles(confirmed);
      return confirmed.length;
    };

    try {
      // A fragmented cache is cheaper to repair with one range request than
      // with dozens of tiny requests. A single large missing range is also
      // handled once.
      if (local.length === 0 || gaps.length > 20) {
        fetchedBars += await fetchGap({ from: start, to: last });
      } else {
        for (const gap of gaps) fetchedBars += await fetchGap(gap);
      }
    } catch (error) {
      fetchErrors.push(error instanceof Error ? error.message : String(error));
    }

    local = store.getCandleRange(instId, timeframe, start, last);
    gaps = missingRuns(local, start, last, tfMs);
  }

  if (!local.length) {
    throw new HistoryError(`${instId} ${timeframe} 历史数据为空`, 422);
  }

  // Missing prefix/suffix is acceptable when the exchange history or local
  // archive simply does not extend that far; the trial reports coverage and
  // only evaluates the contiguous available block. Missing candles *inside*
  // that block would silently change signals, so they remain a hard error.
  const internalGaps = gaps.filter((gap, index) => {
    const atStart = index === 0 && gap.from === start;
    const atEnd = index === gaps.length - 1 && gap.to === last;
    return !atStart && !atEnd;
  });
  if (internalGaps.length) {
    const missing = internalGaps.reduce((sum, gap) => sum + Math.floor((gap.to - gap.from) / tfMs) + 1, 0);
    const detail = fetchErrors.length ? `；补数失败：${fetchErrors[0]}` : '';
    throw new HistoryError(
      `本地历史缺少 ${missing} 根 ${instId} ${timeframe} K 线，且增量补齐后仍有缺口${detail}`,
      fetchErrors.length ? 502 : 422,
    );
  }
  if (fetchErrors.length) {
    throw new HistoryError(
      `本地历史补数失败：${fetchErrors[0]}`,
      502,
    );
  }
  if (options.strictRange && gaps.length) {
    // The exchange closes the current bar a little after the local clock
    // boundary. Allow a single trailing bar to be absent; all older/internal
    // gaps still block a strict custom replay.
    const latestOpen = local.at(-1)?.openTime;
    const onlyCurrentBarLate = latestOpen !== undefined
      && last - latestOpen <= tfMs
      && Math.abs(Date.now() - options.to) <= tfMs * 3
      && gaps.every((gap) => gap.from === last && gap.to === last);
    const strictGaps = onlyCurrentBarLate ? [] : gaps;
    if (strictGaps.length) {
      const missing = strictGaps.reduce((sum, gap) => sum + Math.floor((gap.to - gap.from) / tfMs) + 1, 0);
      throw new HistoryError(
        `所选回放时段的历史 K 线不完整，仍缺少 ${missing} 根 ${instId} ${timeframe}；请缩短日期范围或稍后重试`,
        422,
      );
    }
  }

  const expected = Math.floor((last - start) / tfMs) + 1;
  const coverage = Number(Math.min(1, local.length / expected).toFixed(6));
  const gapsCount = gaps.reduce((sum, gap) => sum + Math.floor((gap.to - gap.from) / tfMs) + 1, 0);
  const source: TrialDataInfo['source'] = fetchedBars > 0
    ? (localBefore > 0 ? 'local+remote' : 'remote')
    : 'local';

  return {
    candles: local,
    source,
    localBars: localBefore,
    fetchedBars,
    coverage,
    gaps: gapsCount,
    from: start,
    to: last,
    requestedFrom: options.from,
    requestedTo: options.to,
  };
}
