import type { ChartIndicatorConfig, ChartIndicatorKey } from '../../lib/chart/types';

const LABELS: Record<ChartIndicatorKey, { name: string; hint: string }> = {
  boll: { name: 'BOLL 布林带', hint: '主图 · 上/中/下轨' },
  volume: { name: '成交量', hint: '独立 pane · 成交额 + MA' },
  kdj: { name: 'KDJ 随机指标', hint: '独立 pane · K/D/J' },
  rsi: { name: 'RSI 相对强弱', hint: '独立 pane · 30/70 参考' },
  macd: { name: 'MACD 指数平滑', hint: '独立 pane · DIF/DEA/柱' },
  ma: { name: 'MA 均线', hint: '主图 · 4 条均线' },
};

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="chart-param">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (Number.isFinite(parsed)) onChange(Math.min(max, Math.max(min, parsed)));
        }}
      />
    </label>
  );
}

export function IndicatorPanel({
  config,
  onChange,
  onClose,
}: {
  config: ChartIndicatorConfig;
  onChange: (next: ChartIndicatorConfig) => void;
  onClose: () => void;
}) {
  const setEnabled = (key: ChartIndicatorKey, enabled: boolean) => {
    onChange({ ...config, [key]: { ...config[key], enabled } });
  };
  return (
    <div className="chart-popover chart-indicator-panel" data-testid="chart-indicator-panel">
      <div className="chart-popover-head">
        <div>
          <div className="chart-popover-title">技术指标</div>
          <div className="chart-popover-sub">参数修改会立即重算，配置保存在本机</div>
        </div>
        <button type="button" className="chart-popover-close" onClick={onClose} aria-label="关闭指标面板">×</button>
      </div>
      <div className="chart-indicator-list">
        {(Object.keys(LABELS) as ChartIndicatorKey[]).map((key) => {
          const enabled = config[key].enabled;
          return (
            <div className={`chart-indicator-item${enabled ? ' on' : ''}`} key={key} data-testid={`chart-indicator-${key}`}>
              <label className="chart-indicator-toggle">
                <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(key, event.target.checked)} />
                <span>
                  <strong>{LABELS[key].name}</strong>
                  <small>{LABELS[key].hint}</small>
                </span>
              </label>
              {enabled ? (
                <div className="chart-param-row">
                  {key === 'boll' ? (
                    <>
                      <NumberField label="周期" value={config.boll.length} min={2} max={200} onChange={(value) => onChange({ ...config, boll: { ...config.boll, length: value } })} />
                      <NumberField label="倍数" value={config.boll.mult} min={0.1} max={10} step={0.1} onChange={(value) => onChange({ ...config, boll: { ...config.boll, mult: value } })} />
                    </>
                  ) : null}
                  {key === 'volume' ? (
                    <NumberField label="MA" value={config.volume.maLength} min={1} max={200} onChange={(value) => onChange({ ...config, volume: { ...config.volume, maLength: value } })} />
                  ) : null}
                  {key === 'kdj' ? (
                    <>
                      <NumberField label="周期" value={config.kdj.length} min={2} max={200} onChange={(value) => onChange({ ...config, kdj: { ...config.kdj, length: value } })} />
                      <NumberField label="K 平滑" value={config.kdj.kSmooth} min={1} max={20} onChange={(value) => onChange({ ...config, kdj: { ...config.kdj, kSmooth: value } })} />
                      <NumberField label="D 平滑" value={config.kdj.dSmooth} min={1} max={20} onChange={(value) => onChange({ ...config, kdj: { ...config.kdj, dSmooth: value } })} />
                    </>
                  ) : null}
                  {key === 'rsi' ? (
                    <NumberField label="周期" value={config.rsi.length} min={2} max={200} onChange={(value) => onChange({ ...config, rsi: { ...config.rsi, length: value } })} />
                  ) : null}
                  {key === 'macd' ? (
                    <>
                      <NumberField label="快" value={config.macd.fast} min={2} max={100} onChange={(value) => onChange({ ...config, macd: { ...config.macd, fast: value } })} />
                      <NumberField label="慢" value={config.macd.slow} min={3} max={200} onChange={(value) => onChange({ ...config, macd: { ...config.macd, slow: Math.max(value, config.macd.fast + 1) } })} />
                      <NumberField label="信号" value={config.macd.signal} min={2} max={100} onChange={(value) => onChange({ ...config, macd: { ...config.macd, signal: value } })} />
                    </>
                  ) : null}
                  {key === 'ma' ? (
                    <label className="chart-param wide">
                      <span>周期</span>
                      <input
                        type="text"
                        value={config.ma.periods.join(',')}
                        onChange={(event) => {
                          const periods = event.target.value
                            .split(',')
                            .map((item) => Number(item.trim()))
                            .filter((item) => Number.isInteger(item) && item >= 2 && item <= 200)
                            .slice(0, 4);
                          onChange({ ...config, ma: { ...config.ma, periods: periods.length ? periods : [5, 10, 20, 60] } });
                        }}
                      />
                    </label>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
