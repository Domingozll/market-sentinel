import type { Overlay } from 'klinecharts';
import type { ChartPoint, DrawingTool, SerializedOverlay } from './types';

export const DRAWING_GROUP = 'user-drawings';
export const EVENT_GROUP = 'rule-events';

export const DRAWING_NAMES: DrawingTool[] = [
  'segment',
  'horizontalStraightLine',
  'rayLine',
  'priceChannelLine',
  'fibonacciLine',
  'simpleAnnotation',
  'brush',
];

export function isDrawingTool(value: string): value is DrawingTool {
  return (DRAWING_NAMES as string[]).includes(value);
}

export function serializeDrawings(overlays: Overlay[]): SerializedOverlay[] {
  return overlays
    .filter((overlay) => isDrawingTool(overlay.name))
    .map((overlay) => ({
      name: overlay.name as DrawingTool,
      points: overlay.points
        .filter((point): point is ChartPoint => typeof point.timestamp === 'number' && typeof point.value === 'number')
        .map((point) => ({
          timestamp: point.timestamp as number,
          value: point.value as number,
          ...(typeof point.dataIndex === 'number' ? { dataIndex: point.dataIndex } : {}),
        })),
      lock: overlay.lock,
      visible: overlay.visible,
    }))
    .filter((overlay) => overlay.points.length > 0);
}
