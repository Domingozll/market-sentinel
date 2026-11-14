import { registerOverlay, type Chart, type OverlayFigure } from 'klinecharts';
import { CHART_COLORS } from './chartTheme';
import { computeVolumeProfile, type VolumeProfileBar } from './volumeProfile';
import type { VolumeProfileSettings } from './types';

export const VOLUME_PROFILE_OVERLAY = 'MS_VOLUME_PROFILE';

export interface VolumeProfileOverlayState {
  settings: VolumeProfileSettings;
  revision: number;
}

let registered = false;

function profileBars(chart: Chart, range: { from: number; to: number }): VolumeProfileBar[] {
  return chart
    .getDataList()
    .slice(Math.max(0, range.from), range.to + 1)
    .map((bar) => ({
      low: bar.low,
      high: bar.high,
      turnover: bar.turnover ?? bar.volume ?? 0,
    }));
}

function priceY(chart: Chart, value: number): number | null {
  const coordinate = chart.convertToPixel({ value }, { paneId: 'candle_pane' }) as { y?: number };
  return typeof coordinate.y === 'number' ? coordinate.y : null;
}

function createFigures(chart: Chart, state: VolumeProfileOverlayState): OverlayFigure[] {
  if (!state.settings.enabled) return [];
  const range = chart.getVisibleRange();
  const bars = profileBars(chart, range);
  const profile = computeVolumeProfile(bars, state.settings.bins);
  if (!profile.bins.length || !(profile.maxVolume > 0)) return [];
  const size = chart.getSize('candle_pane');
  if (!size) return [];
  const width = Math.min(95, Math.max(16, size.width * 0.18));
  const right = size.width - 3;
  const figures: OverlayFigure[] = [];
  for (const bin of profile.bins) {
    const top = priceY(chart, bin.high);
    const bottom = priceY(chart, bin.low);
    if (top === null || bottom === null) continue;
    const y = Math.min(top, bottom);
    const height = Math.max(1, Math.abs(bottom - top));
    const barWidth = Math.max(1, (bin.volume / profile.maxVolume) * width);
    figures.push({
      type: 'rect',
      attrs: { x: right - barWidth, y, width: barWidth, height: Math.max(1, height - 1) },
      styles: { style: 'fill', color: 'rgba(49,215,194,.24)' },
      ignoreEvent: true,
    });
  }
  if (state.settings.showPoc && profile.poc !== null) {
    const y = priceY(chart, profile.poc);
    if (y !== null) {
      figures.push({
        type: 'line',
        attrs: { coordinates: [{ x: right - width, y }, { x: right, y }] },
        styles: { color: CHART_COLORS.poc, size: 1 },
        ignoreEvent: true,
      });
      figures.push({
        type: 'text',
        attrs: { x: right - width - 3, y, text: 'POC', baseline: 'middle', align: 'right' },
        styles: { color: CHART_COLORS.poc, size: 9, backgroundColor: '#080d13', paddingLeft: 3, paddingRight: 3 },
        ignoreEvent: true,
      });
    }
  }
  if (state.settings.showValueArea && profile.valueLow !== null && profile.valueHigh !== null) {
    for (const value of [profile.valueLow, profile.valueHigh]) {
      const y = priceY(chart, value);
      if (y === null) continue;
      figures.push({
        type: 'line',
        attrs: { coordinates: [{ x: right - width, y }, { x: right, y }] },
        styles: { color: 'rgba(239,180,93,.65)', size: 1, style: 'dashed' },
        ignoreEvent: true,
      });
    }
  }
  return figures;
}

export function registerVolumeProfileOverlay(): void {
  if (registered) return;
  registered = true;
  registerOverlay<VolumeProfileOverlayState>({
    name: VOLUME_PROFILE_OVERLAY,
    totalStep: 1,
    lock: true,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ chart, overlay }) => {
      const state = overlay.extendData as VolumeProfileOverlayState | undefined;
      return createFigures(chart, state ?? { settings: { enabled: false, bins: 80, showValueArea: true, showPoc: true }, revision: 0 });
    },
  });
}

export function forceVolumeProfileRedraw(chart: Chart, state: VolumeProfileOverlayState): void {
  const overlay = chart.getOverlays({ name: VOLUME_PROFILE_OVERLAY })[0];
  if (!overlay) return;
  const last = chart.getDataList().at(-1);
  const points = last
    ? [{ timestamp: last.timestamp, value: last.close }]
    : overlay.points;
  const extendData = { ...state, revision: state.revision + 1 };
  overlay.extendData = extendData;
  chart.overrideOverlay({ id: overlay.id, points, extendData });
}
