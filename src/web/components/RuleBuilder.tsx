import {
  defaultParamsFor,
  normalizeParams,
  SERIES_CATALOG,
  SERIES_GROUPS,
  TIMEFRAMES,
  type Comparator,
  type Condition,
  type ConditionEvaluation,
  type ConditionGroup,
  type ExpressionNode,
  type IndicatorParams,
  type SeriesKey,
  type Timeframe,
} from '../../shared/types';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { defaultRightSeriesFor, defaultThresholdFor } from '../lib/templates';
import { formatNumber, seriesParamsLabel } from '../lib/format';

type NodePath = number[];

const COMPARATORS: { value: Comparator; label: string }[] = [
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
];

function updateNode(node: ExpressionNode, path: NodePath, updater: (node: ExpressionNode) => ExpressionNode): ExpressionNode {
  if (path.length === 0) return updater(node);
  if (node.kind !== 'group') return node;
  const [head, ...rest] = path;
  if (head < 0 || head >= node.children.length) return node;
  const children = [...node.children];
  children[head] = updateNode(children[head], rest, updater);
  return { ...node, children };
}

export function countConditions(node: ExpressionNode): number {
  if (node.kind === 'condition') return 1;
  return node.children.reduce((sum, child) => sum + countConditions(child), 0);
}

interface BuilderHandlers {
  setGroupOp: (path: NodePath, op: 'AND' | 'OR') => void;
  addCondition: (path: NodePath) => void;
  addGroup: (path: NodePath, depth: number) => void;
  removeNode: (path: NodePath) => void;
  moveNode: (path: NodePath, delta: -1 | 1) => void;
  updateCondition: (path: NodePath, condition: Condition) => void;
}

export function RuleBuilder({
  expression,
  onChange,
  preview,
}: {
  expression: ConditionGroup;
  onChange: (expression: ConditionGroup) => void;
  preview: Map<string, ConditionEvaluation>;
}) {
  const total = countConditions(expression);
  const update = (path: NodePath, updater: (node: ExpressionNode) => ExpressionNode) => {
    onChange(updateNode(expression, path, updater) as ConditionGroup);
  };
  const handlers: BuilderHandlers = {
    setGroupOp: (path, op) => {
      update(path, (node) => (node.kind === 'group' ? { ...node, op } : node));
    },
    addCondition: (path) => {
      if (total >= 12) return;
      update(path, (node) =>
        node.kind === 'group'
          ? { ...node, children: [...node.children, defaultBlankCondition()] }
          : node,
      );
    },
    addGroup: (path, depth) => {
      if (total >= 12 || depth >= 3) return;
      update(path, (node) =>
        node.kind === 'group'
          ? { ...node, children: [...node.children, { kind: 'group', op: 'AND', children: [defaultBlankCondition()] }] }
          : node,
      );
    },
    removeNode: (path) => {
      if (path.length === 0) return;
      const parentPath = path.slice(0, -1);
      const index = path[path.length - 1];
      update(parentPath, (node) =>
        node.kind === 'group'
          ? { ...node, children: node.children.filter((_, childIndex) => childIndex !== index) }
          : node,
      );
    },
    moveNode: (path, delta) => {
      if (path.length === 0) return;
      const parentPath = path.slice(0, -1);
      const index = path[path.length - 1];
      update(parentPath, (node) => {
        if (node.kind !== 'group') return node;
        const target = index + delta;
        if (target < 0 || target >= node.children.length) return node;
        const children = [...node.children];
        [children[index], children[target]] = [children[target], children[index]];
        return { ...node, children };
      });
    },
    updateCondition: (path, condition) => {
      update(path, () => condition);
    },
  };

  return (
    <GroupNode
      group={expression}
      path={[]}
      depth={1}
      total={total}
      preview={preview}
      handlers={handlers}
      isRoot
    />
  );
}

function GroupNode({
  group,
  path,
  depth,
  total,
  preview,
  handlers,
  isRoot,
}: {
  group: ConditionGroup;
  path: NodePath;
  depth: number;
  total: number;
  preview: Map<string, ConditionEvaluation>;
  handlers: BuilderHandlers;
  isRoot: boolean;
}) {
  return (
    <div className={`logic-group${isRoot ? '' : ' nested'}`}>
      <div className="logic-group-header">
        <div className="logic-title">
          {isRoot ? <span style={{ color: '#8ca2b1' }}>当以下条件</span> : <span>条件组</span>}
          <GroupOpSelect op={group.op} onChange={(op) => handlers.setGroupOp(path, op)} />
          {isRoot ? <span style={{ color: '#526879', fontFamily: 'var(--mono)', fontSize: 8 }}>{total} / 12 个条件 · 最多 3 层</span> : null}
        </div>
        {!isRoot ? (
          <div className="group-controls">
            <button type="button" className="tiny-icon" aria-label="条件组上移" onClick={() => handlers.moveNode(path, -1)}><ArrowUp size={12} /></button>
            <button type="button" className="tiny-icon" aria-label="条件组下移" onClick={() => handlers.moveNode(path, 1)}><ArrowDown size={12} /></button>
            <button type="button" className="tiny-icon" aria-label="删除条件组" onClick={() => handlers.removeNode(path)}><Trash2 size={12} /></button>
          </div>
        ) : null}
      </div>
      <div className="condition-stack">
        {group.children.map((child, index) => {
          const childPath = [...path, index];
          return (
            <div key={child.kind === 'condition' ? child.id : `${childPath.join('-')}-group`}>
              {index > 0 ? <div className="connector-box"><span>{group.op === 'AND' ? '且' : '或'}</span></div> : null}
              {child.kind === 'condition' ? (
                <ConditionEditor
                  condition={child}
                  ordinal={index + 1}
                  preview={preview.get(child.id)}
                  onChange={(condition) => handlers.updateCondition(childPath, condition)}
                  onRemove={() => handlers.removeNode(childPath)}
                  onMove={(delta) => handlers.moveNode(childPath, delta)}
                  canMoveUp={index > 0}
                  canMoveDown={index < group.children.length - 1}
                />
              ) : (
                <GroupNode
                  group={child}
                  path={childPath}
                  depth={depth + 1}
                  total={total}
                  preview={preview}
                  handlers={handlers}
                  isRoot={false}
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="add-condition-row">
        <button type="button" className="add-condition" onClick={() => handlers.addCondition(path)} disabled={total >= 12} data-testid="add-condition">
          <Plus size={11} /> 添加条件
        </button>
        <button
          type="button"
          className="add-condition"
          onClick={() => handlers.addGroup(path, depth)}
          disabled={total >= 12 || depth >= 3}
          data-testid="add-group"
        >
          <Plus size={11} /> 添加子条件组
        </button>
      </div>
    </div>
  );
}

function GroupOpSelect({ op, onChange }: { op: 'AND' | 'OR'; onChange: (op: 'AND' | 'OR') => void }) {
  return (
    <select
      className="logic-op-select"
      value={op}
      onChange={(event) => onChange(event.target.value as 'AND' | 'OR')}
      aria-label="条件组逻辑"
    >
      <option value="AND">全部满足 AND</option>
      <option value="OR">任一满足 OR</option>
    </select>
  );
}

function ConditionEditor({
  condition,
  ordinal,
  preview,
  onChange,
  onRemove,
  onMove,
  canMoveUp,
  canMoveDown,
}: {
  condition: Condition;
  ordinal: number;
  preview?: ConditionEvaluation;
  onChange: (condition: Condition) => void;
  onRemove: () => void;
  onMove: (delta: -1 | 1) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const leftParams = normalizeParams(condition.left.series, condition.left.params);
  const rightParams = condition.right.type === 'series'
    ? normalizeParams(condition.right.series, condition.right.params)
    : null;
  const updateLeftSeries = (series: SeriesKey) => {
    onChange({
      ...condition,
      left: { series, params: defaultParamsFor(series) },
    });
  };
  const updateRightType = (type: 'number' | 'series') => {
    if (type === 'number') {
      onChange({ ...condition, right: { type: 'number', value: defaultThresholdFor(condition.left.series) } });
    } else {
      const series = defaultRightSeriesFor(condition.left.series);
      onChange({ ...condition, right: { type: 'series', series, params: defaultParamsFor(series) } });
    }
  };
  const updateRightSeries = (series: SeriesKey) => {
    if (condition.right.type !== 'series') return;
    onChange({ ...condition, right: { type: 'series', series, params: defaultParamsFor(series) } });
  };
  const updateLeftParams = (params: IndicatorParams) => {
    onChange({ ...condition, left: { ...condition.left, params } });
  };
  const updateRightParams = (params: IndicatorParams) => {
    if (condition.right.type !== 'series') return;
    onChange({ ...condition, right: { ...condition.right, params } });
  };
  return (
    <div className="condition-card editor-condition" data-testid="condition-row">
      <div className="condition-editor-top">
        <div className="condition-number"><span className="idx">{ordinal}</span> 条件</div>
        <div className="condition-tools">
          {preview ? (
            <span className={`mini-value${preview.truth ? '' : ' bad'}`}>
              {preview.truth ? '当前成立' : '当前未成立'} · {formatNumber(preview.leftValue)} {preview.rightSeries ? `vs ${formatNumber(preview.rightValue)}` : `/${formatNumber(preview.rightValue)}`}
            </span>
          ) : null}
          <button type="button" className="tiny-icon" title="上移" aria-label="条件上移" disabled={!canMoveUp} onClick={() => onMove(-1)}><ArrowUp size={12} /></button>
          <button type="button" className="tiny-icon" title="下移" aria-label="条件下移" disabled={!canMoveDown} onClick={() => onMove(1)}><ArrowDown size={12} /></button>
          <button type="button" className="tiny-icon" title="删除条件" aria-label="删除条件" onClick={onRemove}><Trash2 size={12} /></button>
        </div>
      </div>
      <div className="condition-builder-row">
        <select
          className="mini-select"
          value={condition.timeframe}
          onChange={(event) => onChange({ ...condition, timeframe: event.target.value as Timeframe })}
          aria-label={`条件 ${ordinal} 时间周期`}
        >
          {TIMEFRAMES.map((timeframe) => <option key={timeframe} value={timeframe}>{timeframe}</option>)}
        </select>
        <select
          className="mini-select"
          value={condition.left.series}
          onChange={(event) => updateLeftSeries(event.target.value as SeriesKey)}
          aria-label={`条件 ${ordinal} 指标`}
          style={{ maxWidth: 240 }}
        >
          {SERIES_GROUPS.map((group) => (
            <optgroup key={group.key} label={group.label}>
              {group.series.map((series) => <option key={series} value={series}>{SERIES_CATALOG[series].label}</option>)}
            </optgroup>
          ))}
        </select>
        <select
          className="mini-select op"
          value={condition.cmp}
          onChange={(event) => onChange({ ...condition, cmp: event.target.value as Comparator })}
          aria-label={`条件 ${ordinal} 比较符`}
        >
          {COMPARATORS.map((cmp) => <option key={cmp.value} value={cmp.value}>{cmp.label}</option>)}
        </select>
        <select
          className="mini-select"
          value={condition.right.type}
          onChange={(event) => updateRightType(event.target.value as 'number' | 'series')}
          aria-label={`条件 ${ordinal} 右侧类型`}
        >
          <option value="number">固定数值</option>
          <option value="series">指标值</option>
        </select>
        {condition.right.type === 'number' ? (
          <input
            type="number"
            step="any"
            className="mini-input"
            value={condition.right.value}
            onChange={(event) => onChange({ ...condition, right: { type: 'number', value: Number(event.target.value) } })}
            aria-label={`条件 ${ordinal} 阈值`}
          />
        ) : (
          <select
            className="mini-select"
            value={condition.right.series}
            onChange={(event) => updateRightSeries(event.target.value as SeriesKey)}
            aria-label={`条件 ${ordinal} 右侧指标`}
            style={{ maxWidth: 230 }}
          >
            {SERIES_GROUPS.map((group) => (
              <optgroup key={group.key} label={group.label}>
                {group.series.map((series) => <option key={series} value={series}>{SERIES_CATALOG[series].label}</option>)}
              </optgroup>
            ))}
          </select>
        )}
      </div>
      <div className="param-fields">
        <span className="form-hint">{SERIES_CATALOG[condition.left.series].label}{seriesParamsLabel(condition.left.series, condition.left.params) ? `(${seriesParamsLabel(condition.left.series, condition.left.params)})` : ''}</span>
        {SERIES_CATALOG[condition.left.series].paramsKind ? (
          <ParamInputs
            series={condition.left.series}
            params={leftParams}
            onChange={updateLeftParams}
            labelPrefix="左侧"
          />
        ) : null}
        {condition.right.type === 'series' && rightParams ? (
          <ParamInputs
            series={condition.right.series}
            params={rightParams}
            onChange={updateRightParams}
            labelPrefix="右侧"
          />
        ) : null}
      </div>
    </div>
  );
}

function ParamInputs({
  series,
  params,
  onChange,
  labelPrefix,
}: {
  series: SeriesKey;
  params: IndicatorParams;
  onChange: (params: IndicatorParams) => void;
  labelPrefix: string;
}) {
  const meta = SERIES_CATALOG[series];
  const kind = meta.paramsKind;
  if (!kind) return null;
  const field = (key: keyof IndicatorParams, label: string, min: number, max: number, integer = true) => (
    <label className="param-field" key={key}>
      {labelPrefix}{label}
      <input
        type="number"
        min={min}
        max={max}
        step={integer ? 1 : 0.1}
        value={params[key] ?? ''}
        onChange={(event) => onChange({ ...params, [key]: Number(event.target.value) })}
      />
    </label>
  );
  return (
    <>
      {kind === 'bb' && (
        <>
          {field('length', '周期', 2, 500)}
          {field('mult', '倍数', 0.1, 10, false)}
          {series === 'bb.midSlope' ? field('slopeWindow', '斜率根数', 1, 50) : null}
        </>
      )}
      {kind === 'kdj' && (
        <>
          {field('length', '周期', 2, 500)}
          {field('kSmooth', 'K平滑', 1, 20)}
          {field('dSmooth', 'D平滑', 1, 20)}
        </>
      )}
      {kind === 'rsi' && field('length', '周期', 2, 500)}
      {kind === 'macd' && (
        <>
          {field('fast', '快线', 2, 100)}
          {field('slow', '慢线', 3, 200)}
          {field('signal', '信号线', 2, 100)}
        </>
      )}
      {kind === 'volume' && field('maLength', '均量周期', 1, 500)}
    </>
  );
}

function defaultBlankCondition(): Condition {
  return {
    kind: 'condition',
    id: (typeof crypto !== 'undefined' && 'randomUUID' in crypto) ? crypto.randomUUID() : `c_${Math.random().toString(36).slice(2)}`,
    timeframe: '5m',
    left: { series: 'price.low', params: defaultParamsFor('price.low') },
    cmp: 'lte',
    right: { type: 'series', series: 'bb.lower', params: defaultParamsFor('bb.lower') },
  };
}
