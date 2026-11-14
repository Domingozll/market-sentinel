export interface VolumeProfileBar {
  low: number;
  high: number;
  turnover: number;
}

export interface VolumeProfileBin {
  low: number;
  high: number;
  volume: number;
}

export interface VolumeProfileResult {
  bins: VolumeProfileBin[];
  maxVolume: number;
  poc: number | null;
  valueLow: number | null;
  valueHigh: number | null;
  totalVolume: number;
}

const EMPTY: VolumeProfileResult = {
  bins: [],
  maxVolume: 0,
  poc: null,
  valueLow: null,
  valueHigh: null,
  totalVolume: 0,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Distribute each bar's quote turnover uniformly over its price interval.
 * This is a deterministic, explainable approximation (not order-book data).
 */
export function computeVolumeProfile(bars: VolumeProfileBar[], binCount = 80): VolumeProfileResult {
  if (!bars.length) return EMPTY;
  const count = clamp(Math.round(binCount), 20, 200);
  const min = Math.min(...bars.map((bar) => bar.low));
  const max = Math.max(...bars.map((bar) => bar.high));
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return EMPTY;
  const step = (max - min) / count;
  const bins: VolumeProfileBin[] = Array.from({ length: count }, (_, i) => ({
    low: min + i * step,
    high: min + (i + 1) * step,
    volume: 0,
  }));
  for (const bar of bars) {
    if (!Number.isFinite(bar.turnover) || bar.turnover <= 0) continue;
    if (!Number.isFinite(bar.low) || !Number.isFinite(bar.high)) continue;
    const lo = clamp(Math.floor((bar.low - min) / step), 0, count - 1);
    const hi = clamp(Math.floor((bar.high - min) / step), 0, count - 1);
    const span = Math.max(1, hi - lo + 1);
    const per = bar.turnover / span;
    for (let i = lo; i <= hi; i++) bins[i].volume += per;
  }
  const totalVolume = bins.reduce((sum, bin) => sum + bin.volume, 0);
  if (!(totalVolume > 0)) return { ...EMPTY, bins };
  let pocIndex = 0;
  for (let i = 1; i < bins.length; i++) {
    if (bins[i].volume > bins[pocIndex].volume) pocIndex = i;
  }
  const target = totalVolume * 0.7;
  let lowIndex = pocIndex;
  let highIndex = pocIndex;
  let included = bins[pocIndex].volume;
  while (included < target && (lowIndex > 0 || highIndex < bins.length - 1)) {
    const left = lowIndex > 0 ? bins[lowIndex - 1].volume : -Infinity;
    const right = highIndex < bins.length - 1 ? bins[highIndex + 1].volume : -Infinity;
    if (left >= right) {
      lowIndex -= 1;
      included += bins[lowIndex].volume;
    } else {
      highIndex += 1;
      included += bins[highIndex].volume;
    }
  }
  const maxVolume = Math.max(...bins.map((bin) => bin.volume));
  return {
    bins,
    maxVolume,
    poc: (bins[pocIndex].low + bins[pocIndex].high) / 2,
    valueLow: bins[lowIndex].low,
    valueHigh: bins[highIndex].high,
    totalVolume,
  };
}
