import { registerOverlay, type OverlayFigure } from 'klinecharts';
import type { ChartEventMarker } from './types';

export const EVENT_MARKER_OVERLAY = 'MS_EVENT_MARKER';

let registered = false;

export function registerEventMarkerOverlay(): void {
  if (registered) return;
  registered = true;
  registerOverlay<ChartEventMarker>({
    name: EVENT_MARKER_OVERLAY,
    totalStep: 1,
    lock: true,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, overlay }): OverlayFigure[] => {
      const point = coordinates[0];
      const marker = overlay.extendData as ChartEventMarker | undefined;
      if (!point || typeof point.x !== 'number' || typeof point.y !== 'number') return [];
      const intrabar = marker?.triggerMode === 'intrabar';
      const color = intrabar ? '#ffb02e' : '#ff4d8d';
      const halo = intrabar ? 'rgba(255,176,46,.22)' : 'rgba(255,77,141,.22)';
      const label = marker?.label || (intrabar ? '盘中' : '触发');
      const figures: OverlayFigure[] = [
        {
          type: 'line',
          attrs: { coordinates: [{ x: point.x, y: point.y - 18 }, { x: point.x, y: point.y + 18 }] },
          styles: { color, size: 3 },
          ignoreEvent: true,
        },
        {
          // A soft halo makes the signal readable over candles and indicator lines.
          type: 'circle',
          attrs: { x: point.x, y: point.y, r: 13 },
          styles: { style: 'fill', color: halo },
        },
        {
          type: 'circle',
          attrs: { x: point.x, y: point.y, r: 6 },
          styles: { style: 'fill', color, borderColor: '#fff', borderSize: 1.5 },
        },
      ];
      if (marker?.label !== '') {
        figures.push({
          type: 'text',
          attrs: {
            x: point.x + 8,
            y: point.y - 14,
            text: label,
            baseline: 'middle',
          },
          styles: {
            color: '#120810',
            size: 10,
            weight: 700,
            backgroundColor: color,
            paddingLeft: 5,
            paddingRight: 5,
            paddingTop: 2,
            paddingBottom: 2,
            borderRadius: 3,
          },
          ignoreEvent: true,
        });
      }
      return figures;
    },
  });
}
