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
      const color = marker?.triggerMode === 'intrabar' ? '#efb45d' : '#31d7c2';
      const figures: OverlayFigure[] = [
        {
          type: 'line',
          attrs: { coordinates: [{ x: point.x, y: point.y - 9 }, { x: point.x, y: point.y + 9 }] },
          styles: { color, size: 2 },
          ignoreEvent: true,
        },
        {
          type: 'circle',
          attrs: { x: point.x, y: point.y, r: 3.5 },
          styles: { style: 'fill', color },
        },
        {
          type: 'text',
          attrs: {
            x: point.x + 5,
            y: point.y - 10,
            text: marker?.triggerMode === 'intrabar' ? '盘中' : '触发',
            baseline: 'middle',
          },
          styles: { color, size: 9, backgroundColor: '#080d13', paddingLeft: 4, paddingRight: 4 },
          ignoreEvent: true,
        },
      ];
      return figures;
    },
  });
}
