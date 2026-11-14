import type { ChartEventMarker } from '../../lib/chart/types';
import { DELIVERY_TEXT, formatDateTime, formatPrice } from '../../lib/format';

export function ChartEventPopover({
  event,
  onClose,
  onOpenEvents,
}: {
  event: ChartEventMarker;
  onClose: () => void;
  onOpenEvents: () => void;
}) {
  return (
    <div className="chart-event-popover" data-testid="chart-event-popover">
      <div className="chart-popover-head">
        <div>
          <div className="chart-popover-title">规则触发</div>
          <div className="chart-popover-sub">{event.symbol} · {event.triggerMode === 'intrabar' ? '盘中' : '收盘'}</div>
        </div>
        <button type="button" className="chart-popover-close" onClick={onClose} aria-label="关闭事件信息">×</button>
      </div>
      <div className="chart-event-name">{event.ruleName}</div>
      <div className="chart-event-grid">
        <span>触发时间</span><b>{formatDateTime(event.triggerAt, true, false)}</b>
        <span>触发价</span><b>{formatPrice(event.price)}</b>
        <span>通知状态</span><b>{event.deliveryStatus && event.deliveryStatus in DELIVERY_TEXT ? DELIVERY_TEXT[event.deliveryStatus as keyof typeof DELIVERY_TEXT] : event.deliveryStatus ?? '未记录'}</b>
      </div>
      {event.note ? <div className="chart-event-note">{event.note}</div> : null}
      <button type="button" className="btn btn-secondary btn-sm" onClick={onOpenEvents}>在事件页查看</button>
    </div>
  );
}
