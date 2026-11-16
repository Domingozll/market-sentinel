import { useEffect, useState } from 'react';
import { History, Loader2 } from 'lucide-react';
import type { PositionCalculationRecord, PositionCalculationSummary } from '../../shared/types';
import { api } from '../api';
import { formatDateTime, formatNumber } from '../lib/format';
import { Modal } from './ui';

function money(value: number): string {
  return formatNumber(value, 2);
}

export function PositionHistoryModal({
  open,
  replayId,
  onClose,
  onView,
}: {
  open: boolean;
  replayId: string;
  onClose: () => void;
  onView: (record: PositionCalculationRecord) => void;
}) {
  const [records, setRecords] = useState<PositionCalculationSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !replayId) return;
    let active = true;
    setLoading(true);
    setError(null);
    api.positionCalculations(replayId, 50)
      .then(({ calculations }) => {
        if (active) setRecords(calculations);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [open, replayId]);

  async function viewRecord(id: string) {
    setViewingId(id);
    setError(null);
    try {
      const { calculation } = await api.positionCalculation(id);
      onView(calculation);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setViewingId(null);
    }
  }

  return (
    <Modal
      open={open}
      title="仓位计算历史"
      subtitle="同一回放、同一组信号和同一仓位参数会复用已保存结果，不重复计算。"
      onClose={onClose}
      wide
      footer={<button type="button" className="btn btn-secondary" onClick={onClose}>关闭</button>}
    >
      <div className="position-history" data-testid="position-history">
        {error ? <div className="error-banner" role="alert">{error}</div> : null}
        {loading ? <div className="position-loading"><Loader2 size={13} className="spin" /> 正在读取计算历史…</div> : null}
        {!loading && !records.length ? (
          <div className="empty-table">这个回放还没有保存的仓位计算记录。</div>
        ) : null}
        {records.length ? (
          <div className="position-history-table">
            <div className="position-history-head">
              <span>时间</span><span>方向/杠杆</span><span>本金</span><span>信号数</span><span>交易数</span><span>期末权益</span><span>总收益</span><span />
            </div>
            {records.map((record) => (
              <div className="position-history-row" key={record.id}>
                <span>{formatDateTime(record.createdAt)}</span>
                <span>{record.direction === 'long' ? '做多' : '做空'} · {record.leverage}x</span>
                <span>{money(record.capital)}</span>
                <span>{record.triggerCount}</span>
                <span>{record.tradeCount}</span>
                <span>{money(record.finalEquity)}</span>
                <span className={record.totalNetPnl >= 0 ? 'positive' : 'negative'}>{money(record.totalNetPnl)} USDT</span>
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  data-testid="position-history-view"
                  disabled={viewingId === record.id}
                  onClick={() => void viewRecord(record.id)}
                >
                  {viewingId === record.id ? <Loader2 size={11} className="spin" /> : <History size={11} />} 查看
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
