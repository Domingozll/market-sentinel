import type { DeepPartial, Styles } from 'klinecharts';

export const CHART_COLORS = {
  up: '#2fd486',
  down: '#f0616a',
  noChange: '#8b9eae',
  accent: '#31d7c2',
  text: '#cbd9e5',
  muted: '#5c7081',
  grid: '#17232d',
  border: '#20303c',
  poc: '#efb45d',
  volume: 'rgba(49,215,194,.26)',
  volumeUp: 'rgba(47,212,134,.38)',
  volumeDown: 'rgba(240,97,106,.38)',
} as const;

export const chartStyles: DeepPartial<Styles> = {
  grid: {
    show: true,
    horizontal: { show: true, color: CHART_COLORS.grid, style: 'dashed', size: 1 },
    vertical: { show: false, color: CHART_COLORS.grid, style: 'dashed', size: 1 },
  },
  candle: {
    type: 'candle_solid',
    bar: {
      compareRule: 'current_open',
      upColor: CHART_COLORS.up,
      downColor: CHART_COLORS.down,
      noChangeColor: CHART_COLORS.noChange,
      upBorderColor: CHART_COLORS.up,
      downBorderColor: CHART_COLORS.down,
      noChangeBorderColor: CHART_COLORS.noChange,
      upWickColor: CHART_COLORS.up,
      downWickColor: CHART_COLORS.down,
      noChangeWickColor: CHART_COLORS.noChange,
    },
    priceMark: {
      show: true,
      high: { show: false },
      low: { show: false },
      last: { show: true, line: { show: true, color: CHART_COLORS.accent, style: 'dashed' } },
    },
    tooltip: {
      showRule: 'none',
      showType: 'standard',
      rect: { color: 'rgba(10,17,24,.96)', borderColor: '#2b3d4b', borderRadius: 3 },
      title: { color: CHART_COLORS.muted, size: 11 },
      legend: { color: CHART_COLORS.text, size: 11, defaultValue: '—' },
    },
  },
  indicator: {
    lines: [
      { color: '#71a7ff', size: 1 },
      { color: '#9e8cff', size: 1 },
      { color: '#f0c06a', size: 1 },
      { color: '#d38bff', size: 1 },
      { color: '#efb45d', size: 1 },
    ],
    bars: [{ upColor: CHART_COLORS.volumeUp, downColor: CHART_COLORS.volumeDown }],
    tooltip: { showRule: 'none', title: { color: CHART_COLORS.muted }, legend: { color: CHART_COLORS.text } },
  },
  xAxis: {
    axisLine: { color: CHART_COLORS.border },
    tickLine: { color: CHART_COLORS.border },
    tickText: { color: CHART_COLORS.muted, size: 10 },
  },
  yAxis: {
    axisLine: { color: CHART_COLORS.border },
    tickLine: { color: CHART_COLORS.border },
    tickText: { color: CHART_COLORS.muted, size: 10 },
  },
  separator: { color: CHART_COLORS.border, size: 1 },
  crosshair: {
    show: true,
    horizontal: {
      show: true,
      line: { show: true, color: '#415768', style: 'dashed' },
      text: { color: CHART_COLORS.text, backgroundColor: '#1b2a34', borderColor: '#415768' },
    },
    vertical: {
      show: true,
      line: { show: true, color: '#415768', style: 'dashed' },
      text: { color: CHART_COLORS.text, backgroundColor: '#1b2a34', borderColor: '#415768' },
    },
  },
};
