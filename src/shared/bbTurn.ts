import type { IndicatorParams } from './types';

/**
 * TypeScript port of the BB-midline inflection detector.
 *
 * The detector predicts a turn of the Bollinger midline (SMA), not a price
 * reversal. It is intentionally causal: every rolling window ends at the
 * current confirmed candle. Only the final discrete gates are adapted to the
 * 320-bar live cache used by the rule engine.
 */

export type BbTurnSeriesValue = (number | null)[];

export interface BbTurnSignals {
  warnTop: BbTurnSeriesValue;
  warnBottom: BbTurnSeriesValue;
  confirmTop: BbTurnSeriesValue;
  confirmBottom: BbTurnSeriesValue;
}

export interface BbTurnCandleLike {
  close: number;
  confirm?: boolean;
}

export interface BbTurnConfig {
  n: number;
  mDec: number;
  zOn: number;
  zWindow: number;
  span: number;
  warmup: number;
  volFloorQ: number;
  volQWindow: number;
  sAbsMin: number;
  zOff: number;
  pers: number;
  tauMin: number;
  tauMax: number;
  rMin: number;
  slopeDb: number;
  cooldown: number;
  confirmPers: number;
}

export const BB_TURN_DEFAULTS: BbTurnConfig = {
  n: 20,
  mDec: 12,
  zOn: 1.0,
  zWindow: 500,
  span: 33,
  warmup: 150,
  volFloorQ: 0.10,
  volQWindow: 500,
  sAbsMin: 0.35,
  zOff: 0.7,
  pers: 1,
  tauMin: 1,
  tauMax: 20,
  rMin: 0.40,
  slopeDb: 0.25,
  cooldown: 6,
  confirmPers: 2,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function lowerBound(values: number[], value: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid] < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

function upperBound(values: number[], value: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid] <= value) low = mid + 1;
    else high = mid;
  }
  return low;
}

function selectKth(values: number[], k: number): number {
  let left = 0;
  let right = values.length - 1;
  while (left < right) {
    const pivot = values[(left + right) >>> 1];
    let i = left;
    let j = right;
    while (i <= j) {
      while (values[i] < pivot) i++;
      while (values[j] > pivot) j--;
      if (i <= j) {
        const tmp = values[i];
        values[i] = values[j];
        values[j] = tmp;
        i++;
        j--;
      }
    }
    if (k <= j) right = j;
    else if (k >= i) left = i;
    else break;
  }
  return values[k];
}

/** Sorted rolling window with O(size) insertion and O(size) MAD selection. */
class RollingStats {
  private queue: number[] = [];
  private sorted: number[] = [];
  private scratch: number[] = [];

  constructor(private capacity: number, private minPeriods: number) {}

  add(value: number): void {
    if (!Number.isFinite(value)) return;
    if (this.queue.length >= this.capacity) {
      const old = this.queue.shift()!;
      const index = lowerBound(this.sorted, old);
      if (this.sorted[index] === old) this.sorted.splice(index, 1);
    }
    this.queue.push(value);
    const index = lowerBound(this.sorted, value);
    this.sorted.splice(index, 0, value);
  }

  get size(): number {
    return this.sorted.length;
  }

  median(): number | null {
    const n = this.sorted.length;
    if (n < this.minPeriods || n === 0) return null;
    if (n % 2 === 1) return this.sorted[(n - 1) >>> 1];
    return (this.sorted[n / 2 - 1] + this.sorted[n / 2]) / 2;
  }

  mad(median: number): number | null {
    const n = this.sorted.length;
    if (n < this.minPeriods || n === 0) return null;
    if (this.scratch.length < n) this.scratch.length = n;
    for (let i = 0; i < n; i++) this.scratch[i] = Math.abs(this.sorted[i] - median);
    const lower = (n - 1) >>> 1;
    const a = selectKth(this.scratch, lower);
    if (n % 2 === 1) return a;
    // selectKth mutated the array, but the lower value is still present and
    // the upper order statistic can be selected in the same array.
    const b = selectKth(this.scratch, n >>> 1);
    return (a + b) / 2;
  }

  z(value: number): number | null {
    const median = this.median();
    if (median === null) return null;
    const mad = this.mad(median);
    if (mad === null || mad <= 0) return null;
    return (value - median) / (mad * 1.4826);
  }

  rank(value: number): number | null {
    const n = this.sorted.length;
    if (n < this.minPeriods || n === 0) return null;
    const less = lowerBound(this.sorted, value);
    const equal = upperBound(this.sorted, value) - less;
    // Average-rank percentile, matching pandas' pct rank for ties.
    return (less + equal / 2) / n;
  }
}

function normalizedConfig(raw?: IndicatorParams): BbTurnConfig {
  const zWindow = clamp(Math.round(raw?.zWindow ?? BB_TURN_DEFAULTS.zWindow), 120, 500);
  return {
    ...BB_TURN_DEFAULTS,
    n: clamp(Math.round(raw?.length ?? BB_TURN_DEFAULTS.n), 2, 500),
    mDec: clamp(Math.round(raw?.mDec ?? BB_TURN_DEFAULTS.mDec), 2, 60),
    zOn: clamp(Number(raw?.zOn ?? BB_TURN_DEFAULTS.zOn), 0.1, 10),
    zWindow,
    volQWindow: zWindow,
  };
}

/**
 * Compute the four signal series. Values are 0/1 and aligned to the input
 * candles. A forming candle is never fed into the detector; its value is 0.
 */
export function computeBbTurnSignals(
  candles: readonly BbTurnCandleLike[],
  rawParams?: IndicatorParams,
): BbTurnSignals {
  const out: BbTurnSignals = {
    warnTop: Array(candles.length).fill(0),
    warnBottom: Array(candles.length).fill(0),
    confirmTop: Array(candles.length).fill(0),
    confirmBottom: Array(candles.length).fill(0),
  };
  const closes: number[] = [];
  const positions: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].confirm !== false && Number.isFinite(candles[i].close)) {
      closes.push(candles[i].close);
      positions.push(i);
    }
  }
  if (closes.length === 0) return out;

  const p = normalizedConfig(rawParams);
  const n = closes.length;
  const ma: Array<number | null> = Array(n).fill(null);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += closes[i];
    if (i >= p.n) sum -= closes[i - p.n];
    if (i >= p.n - 1) ma[i] = sum / p.n;
  }
  const d1: Array<number | null> = Array(n).fill(null);
  const d2: Array<number | null> = Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    if (ma[i] !== null && ma[i - 1] !== null) d1[i] = ma[i]! - ma[i - 1]!;
    if (i >= 2 && d1[i] !== null && d1[i - 1] !== null) d2[i] = d1[i]! - d1[i - 1]!;
  }

  // RiskMetrics EWMA of squared log returns, then one-bar shift. This mirrors
  // curvature.vol_px: sigma[i] uses close/var from i-1, never the current bar.
  const variance: Array<number | null> = Array(n).fill(null);
  const alpha = 1 / p.span;
  let ewma: number | null = null;
  let returnCount = 0;
  for (let i = 1; i < n; i++) {
    const previous = closes[i - 1];
    const current = closes[i];
    if (!(previous > 0) || !(current > 0)) continue;
    const r = Math.log(current / previous);
    ewma = ewma === null ? r * r : alpha * r * r + (1 - alpha) * ewma;
    returnCount++;
    if (returnCount >= p.span) variance[i] = ewma;
  }
  const sigma: Array<number | null> = Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    if (variance[i - 1] !== null && variance[i - 1]! >= 0) {
      sigma[i] = closes[i - 1] * Math.sqrt(variance[i - 1]!);
    }
  }

  const slope: Array<number | null> = Array(n).fill(null);
  const decelRaw: Array<number | null> = Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (d1[i] !== null && sigma[i] !== null && sigma[i]! > 0) slope[i] = d1[i]! / sigma[i]!;
    if (i >= p.mDec && slope[i] !== null && slope[i - p.mDec] !== null) {
      decelRaw[i] = (slope[i]! - slope[i - p.mDec]!) / p.mDec;
    }
  }

  const zdWindow = new RollingStats(p.zWindow, Math.min(120, p.zWindow));
  const volWindow = new RollingStats(p.volQWindow, Math.min(120, p.volQWindow));
  const zd: Array<number | null> = Array(n).fill(null);
  const volRank: Array<number | null> = Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (decelRaw[i] !== null) {
      zdWindow.add(decelRaw[i]!);
      zd[i] = zdWindow.z(decelRaw[i]!);
    }
    if (sigma[i] !== null && sigma[i]! > 0) {
      volWindow.add(sigma[i]!);
      volRank[i] = volWindow.rank(sigma[i]!);
    }
  }

  let prevSign = 0;
  let legStart: number | null = null;
  let confirmedLeg: number | null = null;
  let lastConfirm = Number.NEGATIVE_INFINITY;
  let lastWarn = Number.NEGATIVE_INFINITY;
  let count = 0;
  let armed = 0;

  for (let i = p.warmup; i < n; i++) {
    const s = slope[i];
    const ds = decelRaw[i];
    const z = zd[i];
    const vr = volRank[i];
    const sig = sigma[i];
    if (!finite(s) || !finite(ds) || !finite(z) || !finite(vr) || !finite(sig)) continue;
    if (sig <= 0 || vr < p.volFloorQ) {
      count = 0;
      continue;
    }
    const tau = -s / ds;
    const room = 0.5 * Math.abs(s) * tau;
    if (!Number.isFinite(tau) || !Number.isFinite(room)) continue;

    // Confirm: the slope has crossed the dead zone and stayed there for
    // confirmPers bars. This is a stateful leg, matching curvature._decide.
    const currentSign = s > p.slopeDb ? 1 : s < -p.slopeDb ? -1 : 0;
    if (currentSign !== 0 && currentSign !== prevSign) legStart = i;
    prevSign = currentSign;
    if (
      currentSign !== 0
      && legStart !== null
      && i - legStart + 1 >= p.confirmPers
      && confirmedLeg !== legStart
      && i - lastConfirm >= p.cooldown
    ) {
      const original = positions[i];
      if (currentSign < 0) out.confirmTop[original] = 1;
      else out.confirmBottom[original] = 1;
      confirmedLeg = legStart;
      lastConfirm = i;
    }

    if (i - lastWarn < p.cooldown) continue;

    const side = s > 0 ? -1 : 1;
    const decel = s > 0 ? -z : z;
    if (decel >= p.zOn) count++;
    else {
      count = 0;
      if (decel < p.zOff) armed = 0;
    }
    const ready = count >= p.pers
      && armed === 0
      && Math.abs(s) >= p.sAbsMin
      && decel >= p.zOn
      && tau >= p.tauMin
      && tau <= p.tauMax
      && room >= p.rMin;
    if (!ready) continue;

    const original = positions[i];
    if (side < 0) out.warnTop[original] = 1;
    else out.warnBottom[original] = 1;
    lastWarn = i;
    armed = 1;
    count = 0;
  }

  return out;
}
