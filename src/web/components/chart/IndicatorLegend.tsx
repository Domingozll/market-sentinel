import { Eye, EyeOff, X } from 'lucide-react';
import { formatNumber } from '../../lib/format';
import type { ChartIndicatorKey, IndicatorLegendItem } from '../../lib/chart/types';

const COLOR_CLASS: Record<ChartIndicatorKey, string> = {
  boll: 'boll',
  volume: 'vol',
  kdj: 'kdj',
  rsi: 'rsi',
  macd: 'macd',
  ma: 'ma',
};

export function IndicatorLegend({
  items,
  onEdit,
  onToggleVisible,
  onClose,
}: {
  items: IndicatorLegendItem[];
  onEdit: (key: ChartIndicatorKey) => void;
  onToggleVisible: (key: ChartIndicatorKey) => void;
  onClose: (key: ChartIndicatorKey) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="chart-indicator-legend" data-testid="chart-indicator-legend">
      {items.map((item) => (
        <div
          className={`chart-legend-chip ${COLOR_CLASS[item.key]}${item.visible ? '' : ' is-hidden'}`}
          key={item.key}
          data-testid={`chart-legend-${item.key}`}
        >
          <button
            type="button"
            className="chart-legend-main"
            onClick={() => onEdit(item.key)}
            title={`编辑 ${item.name} 参数`}
          >
            <span className="chart-legend-dot" />
            <strong>{item.name}</strong>
            <span className="chart-legend-params">{item.params}</span>
            {item.visible ? (
              <span className="chart-legend-values">
                {item.values.map((value) => (
                  <span key={value.label}>{value.label} {formatNumber(value.value, 2)}</span>
                ))}
              </span>
            ) : (
              <span className="chart-legend-values muted">已隐藏</span>
            )}
          </button>
          <button
            type="button"
            className="chart-legend-action"
            aria-label={`${item.visible ? '隐藏' : '显示'} ${item.name}`}
            title={`${item.visible ? '隐藏' : '显示'} ${item.name}`}
            data-testid={`chart-legend-visible-${item.key}`}
            onClick={() => onToggleVisible(item.key)}
          >
            {item.visible ? <Eye size={11} /> : <EyeOff size={11} />}
          </button>
          <button
            type="button"
            className="chart-legend-action close"
            aria-label={`关闭 ${item.name}`}
            title={`关闭 ${item.name}`}
            data-testid={`chart-legend-close-${item.key}`}
            onClick={() => onClose(item.key)}
          >
            <X size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}
