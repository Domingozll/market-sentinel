import { useEffect, useRef, useState } from 'react';
import { RotateCcw, SlidersHorizontal, X } from 'lucide-react';
import {
  CHART_INDICATOR_META,
  sanitizeChartIndicatorSettings,
  toggleChartIndicator,
  type ChartIndicatorSettings,
} from '../lib/chartIndicators';

function NumberField({
  label,
  value,
  min,
  max,
  step,
  testId,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  testId: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="indicator-field">
      <span>{label}</span>
      <input
        type="number"
        className="indicator-input"
        value={value}
        min={min}
        max={max}
        step={step}
        data-testid={testId}
        onChange={(event) => {
          const next = event.currentTarget.valueAsNumber;
          if (Number.isFinite(next)) onChange(next);
        }}
      />
    </label>
  );
}

export function ChartIndicatorPanel({
  settings,
  onChange,
}: {
  settings: ChartIndicatorSettings;
  onChange: (next: ChartIndicatorSettings) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const commit = (next: ChartIndicatorSettings) => onChange(sanitizeChartIndicatorSettings(next));
  const toggle = (key: keyof ChartIndicatorSettings) => commit(toggleChartIndicator(settings, key));

  return (
    <div className="indicator-controls" ref={rootRef}>
      <button
        type="button"
        className={`btn btn-secondary btn-sm${open ? ' active' : ''}`}
        aria-expanded={open}
        aria-controls="chart-indicator-panel"
        data-testid="chart-indicators-button"
        onClick={() => setOpen((value) => !value)}
      >
        <SlidersHorizontal size={12} />
        指标
      </button>
      {open ? (
        <div
          className="indicator-popover"
          id="chart-indicator-panel"
          role="dialog"
          aria-label="行情图指标设置"
          data-testid="chart-indicator-panel"
        >
          <div className="indicator-popover-head">
            <div>
              <div className="indicator-popover-title">图表指标</div>
              <div className="indicator-popover-sub">勾选显示，参数修改立即生效</div>
            </div>
            <button type="button" className="icon-btn" aria-label="关闭指标设置" onClick={() => setOpen(false)}>
              <X size={14} />
            </button>
          </div>

          <div className={`indicator-config${settings.boll.enabled ? ' enabled' : ''}`}>
            <div className="indicator-config-head">
              <label className="indicator-toggle">
                <input
                  type="checkbox"
                  checked={settings.boll.enabled}
                  data-testid="indicator-toggle-boll"
                  onChange={() => toggle('boll')}
                />
                <span className="indicator-swatch" style={{ background: CHART_INDICATOR_META.boll.color }} />
                <span>{CHART_INDICATOR_META.boll.label}</span>
              </label>
              <span className="indicator-pane-tag">主图</span>
            </div>
            {settings.boll.enabled ? (
              <div className="indicator-fields two">
                <NumberField label="周期" value={settings.boll.length} min={2} max={200} step={1} testId="indicator-boll-length" onChange={(length) => commit({ ...settings, boll: { ...settings.boll, length } })} />
                <NumberField label="倍数" value={settings.boll.mult} min={0.1} max={10} step={0.1} testId="indicator-boll-mult" onChange={(mult) => commit({ ...settings, boll: { ...settings.boll, mult } })} />
              </div>
            ) : null}
          </div>

          <div className={`indicator-config${settings.volume.enabled ? ' enabled' : ''}`}>
            <div className="indicator-config-head">
              <label className="indicator-toggle">
                <input
                  type="checkbox"
                  checked={settings.volume.enabled}
                  data-testid="indicator-toggle-volume"
                  onChange={() => toggle('volume')}
                />
                <span className="indicator-swatch" style={{ background: CHART_INDICATOR_META.volume.color }} />
                <span>{CHART_INDICATOR_META.volume.label}</span>
              </label>
              <span className="indicator-pane-tag">副图</span>
            </div>
            {settings.volume.enabled ? (
              <div className="indicator-fields two">
                <NumberField label="均量周期" value={settings.volume.maLength} min={1} max={200} step={1} testId="indicator-volume-ma" onChange={(maLength) => commit({ ...settings, volume: { ...settings.volume, maLength } })} />
              </div>
            ) : null}
          </div>

          <div className={`indicator-config${settings.kdj.enabled ? ' enabled' : ''}`}>
            <div className="indicator-config-head">
              <label className="indicator-toggle">
                <input
                  type="checkbox"
                  checked={settings.kdj.enabled}
                  data-testid="indicator-toggle-kdj"
                  onChange={() => toggle('kdj')}
                />
                <span className="indicator-swatch" style={{ background: CHART_INDICATOR_META.kdj.color }} />
                <span>{CHART_INDICATOR_META.kdj.label}</span>
              </label>
              <span className="indicator-pane-tag">副图</span>
            </div>
            {settings.kdj.enabled ? (
              <div className="indicator-fields three">
                <NumberField label="周期" value={settings.kdj.length} min={2} max={200} step={1} testId="indicator-kdj-length" onChange={(length) => commit({ ...settings, kdj: { ...settings.kdj, length } })} />
                <NumberField label="K 平滑" value={settings.kdj.kSmooth} min={1} max={20} step={1} testId="indicator-kdj-k" onChange={(kSmooth) => commit({ ...settings, kdj: { ...settings.kdj, kSmooth } })} />
                <NumberField label="D 平滑" value={settings.kdj.dSmooth} min={1} max={20} step={1} testId="indicator-kdj-d" onChange={(dSmooth) => commit({ ...settings, kdj: { ...settings.kdj, dSmooth } })} />
              </div>
            ) : null}
          </div>

          <div className={`indicator-config${settings.rsi.enabled ? ' enabled' : ''}`}>
            <div className="indicator-config-head">
              <label className="indicator-toggle">
                <input
                  type="checkbox"
                  checked={settings.rsi.enabled}
                  data-testid="indicator-toggle-rsi"
                  onChange={() => toggle('rsi')}
                />
                <span className="indicator-swatch" style={{ background: CHART_INDICATOR_META.rsi.color }} />
                <span>{CHART_INDICATOR_META.rsi.label}</span>
              </label>
              <span className="indicator-pane-tag">副图</span>
            </div>
            {settings.rsi.enabled ? (
              <div className="indicator-fields two">
                <NumberField label="周期" value={settings.rsi.length} min={2} max={200} step={1} testId="indicator-rsi-length" onChange={(length) => commit({ ...settings, rsi: { ...settings.rsi, length } })} />
              </div>
            ) : null}
          </div>

          <div className={`indicator-config${settings.macd.enabled ? ' enabled' : ''}`}>
            <div className="indicator-config-head">
              <label className="indicator-toggle">
                <input
                  type="checkbox"
                  checked={settings.macd.enabled}
                  data-testid="indicator-toggle-macd"
                  onChange={() => toggle('macd')}
                />
                <span className="indicator-swatch" style={{ background: CHART_INDICATOR_META.macd.color }} />
                <span>{CHART_INDICATOR_META.macd.label}</span>
              </label>
              <span className="indicator-pane-tag">副图</span>
            </div>
            {settings.macd.enabled ? (
              <div className="indicator-fields three">
                <NumberField label="快线" value={settings.macd.fast} min={2} max={100} step={1} testId="indicator-macd-fast" onChange={(fast) => commit({ ...settings, macd: { ...settings.macd, fast } })} />
                <NumberField label="慢线" value={settings.macd.slow} min={3} max={200} step={1} testId="indicator-macd-slow" onChange={(slow) => commit({ ...settings, macd: { ...settings.macd, slow } })} />
                <NumberField label="信号" value={settings.macd.signal} min={2} max={100} step={1} testId="indicator-macd-signal" onChange={(signal) => commit({ ...settings, macd: { ...settings.macd, signal } })} />
              </div>
            ) : null}
          </div>

          <div className="indicator-popover-foot">
            <span>设置保存在本机浏览器</span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              data-testid="indicator-reset"
              onClick={() => commit(sanitizeChartIndicatorSettings({}))}
            >
              <RotateCcw size={11} /> 恢复默认
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
