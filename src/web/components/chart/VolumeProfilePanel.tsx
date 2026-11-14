import type { VolumeProfileSettings } from '../../lib/chart/types';

export function VolumeProfilePanel({
  settings,
  onChange,
  onClose,
}: {
  settings: VolumeProfileSettings;
  onChange: (settings: VolumeProfileSettings) => void;
  onClose: () => void;
}) {
  return (
    <div className="chart-popover chart-indicator-panel" data-testid="chart-volume-profile-panel">
      <div className="chart-popover-head">
        <div>
          <div className="chart-popover-title">Volume Profile</div>
          <div className="chart-popover-sub">当前可见范围的成交额分布</div>
        </div>
        <button type="button" className="chart-popover-close" onClick={onClose} aria-label="关闭成交量分布设置">×</button>
      </div>
      <div className="chart-indicator-list">
        <label className="chart-indicator-toggle">
          <input
            type="checkbox"
            data-testid="volume-profile-enabled"
            checked={settings.enabled}
            onChange={(event) => onChange({ ...settings, enabled: event.target.checked })}
          />
          <span><strong>显示成交量分布</strong><small>右侧水平柱 · POC/VA</small></span>
        </label>
        <div className="chart-param-row">
          <label className="chart-param">
            <span>价格分箱</span>
            <select
              value={settings.bins}
              onChange={(event) => onChange({ ...settings, bins: Number(event.target.value) })}
            >
              {[40, 60, 80, 100].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="chart-check">
            <input
              type="checkbox"
              checked={settings.showPoc}
              onChange={(event) => onChange({ ...settings, showPoc: event.target.checked })}
            />
            POC
          </label>
          <label className="chart-check">
            <input
              type="checkbox"
              checked={settings.showValueArea}
              onChange={(event) => onChange({ ...settings, showValueArea: event.target.checked })}
            />
            Value Area
          </label>
        </div>
      </div>
    </div>
  );
}
