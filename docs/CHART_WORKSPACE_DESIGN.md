# 专业 K 线工作台升级设计

> 状态：v1.0 已实现；v1.1 价格层级数据仍为设计扩展  
> 实现规范：[CHART_WORKSPACE_IMPLEMENTATION_SPEC.md](./CHART_WORKSPACE_IMPLEMENTATION_SPEC.md)  
> 目标：把当前总览里的简易 ECharts K 线，升级为接近交易所 / TradingView 工作流的专业图表工具，并支持可扩展指标和侧边成交量分布图。  
> 建议版本：v1.2（先新增 `/chart`，验证后再替换总览和内嵌试跑图表）

## 1. 结论

建议采用 **KLineChart 10.1.x** 作为新的图表内核，而不是继续在 ECharts 上叠加交互，也不是直接引入 TradingView Charting Library。

选择理由：

- Apache-2.0，零运行时依赖，Gzip 约 50 KB，和本项目 MIT 开源定位一致。
- 原生支持 K 线、缩放/平移、多 pane、十字光标、指标 pane、移动端手势。
- 内置大量技术指标和 **画线工具**（趋势线、射线、水平线、通道、斐波那契、文字、画笔等），不需要自己实现整套金融图交互。
- v10 的 `setDataLoader` 正好支持本项目需要的“REST 历史数据 + 实时最新一根 K 线”模型，含左右分页、实时增量更新、切换 symbol/period 自动重载。
- `registerIndicator` / `registerOverlay` / `getFigureClass` 足够实现自定义指标和侧边 Volume Profile。
- 当前 ECharts 依赖约 1.5 MB 前端产物（gzip 约 490 KB）；迁移完成后可移除 ECharts，整体包体反而明显下降。

不选其他方案的原因：

| 方案 | 优点 | 不适合本次目标的原因 |
|---|---|---|
| 继续使用 ECharts 6 | 已在项目中、基础 K 线稳定 | 金融图交互、画线、图层、pane 管理需要大量自研；难以接近交易所体验 |
| TradingView Lightweight Charts 5.x | 渲染专业、API 干净、支持 panes 和 custom primitives | 没有内置画线工具和指标库，成交量分布、趋势线、Fibonacci 都要自己做；还需要按规定显示 TradingView 归属 |
| TradingView Charting Library | 最接近完整 TradingView | 需要额外授权/协议，闭源、集成和分发约束大，不适合作为本地 MIT 项目的默认依赖 |
| KLineChart 10.x | 金融图交互、画线、指标、移动端开箱即用 | 需要一次 spike 验证自定义 Volume Profile 和项目视觉风格；v10 API 与旧教程不同，需锁定版本 |

**推荐范围：** 先做独立的 `/chart` 专业图表页，保留当前总览小图作为快速预览；等 KLineChart 版本覆盖总览和试跑图表后，再移除 ECharts。

## 2. 当前实现评估

当前相关代码：

- `src/web/components/MarketChart.tsx`：ECharts 渲染 K 线、BOLL、成交量、KDJ、RSI、MACD、规则标记。
- `src/web/components/ChartIndicatorPanel.tsx`：现有 5 个指标的开关和参数面板。
- `src/web/lib/chartIndicators.ts`：指标配置类型、localStorage、图例。
- `src/server/indicators.ts`：规则引擎和图表共用的指标公式。
- `src/web/pages/DashboardPage.tsx`：每 15 秒拉取 240 根 K 线；没有实时单根更新。
- `GET /api/candles`：最多返回 500 根，暂不支持 `before` 分页；没有 K 线 SSE。
- `TrialModal`：复用同一个 `MarketChart` 展示试跑触发点。

当前能力足够做监控，但距离“专业图表工具”缺少：

1. 连续历史分页（拖到左侧继续加载）。
2. 单根 K 线实时更新和形成中 K 线平滑刷新。
3. 十字光标 OHLCV 读数、可调整 pane 高度、图表全屏。
4. 指标管理器（增删、排序、参数、多指标叠加），而不只是固定的 5 个开关。
5. 画线工具、测量工具、画线保存/恢复。
6. 侧边 Volume Profile、POC/VAH/VAL。
7. 规则触发标记的点击与事件详情联动。
8. 专业图表页的 URL 状态、键盘快捷键、移动端工具栏。
9. 更多指标（MA/EMA/VWAP/ATR/Stoch/ADX/OBV/Ichimoku 等）。

## 3. 产品目标

### P0：可用版本（建议第一轮交付）

- 新增 `/chart` 专业图表页，支持通过 URL 保存 `symbol` / `timeframe`：`/chart?symbol=BTC-USDT-SWAP&timeframe=5m`。
- 总览图表旁增加“专业图表”入口；总览小图暂不删除。
- 9 个周期：`1m / 3m / 5m / 15m / 30m / 1H / 2H / 4H / 1D`。
- 品种搜索：复用 `/api/instruments?query=`，支持收藏/最近使用（最近使用可先 localStorage）。
- 专业 K 线交互：滚轮缩放、拖拽平移、双击/按钮复位、十字光标、右侧价格轴、时间轴、全屏、截图。
- 初始加载 500 根；向左拖动分页加载更早数据，最多保留 5,000 根在前端。
- 指标：BOLL、VOL、KDJ、RSI、MACD（先保证与规则公式一致），并支持 MA/EMA 叠加（P0 可只做 MA）。
- 多 pane：主图 + 成交量 + 最多 2 个指标 pane；pane 可拖动调整高度、可关闭。
- 侧边 Volume Profile：当前可见范围、右侧水平成交量条、POC/VAH/VAL、开关和颜色/分箱设置。
- 规则触发标记：显示事件价格/时间，点击打开事件详情或跳转规则。
- 画线工具：趋势线、水平线、射线、通道、斐波那契、文字、画笔；支持删除、锁定、清空。
- 图表配置持久化：指标、pane、画线、VP 设置保存到 localStorage；预留服务端同步接口。
- 移动端：工具栏横向滚动，指标/画线/VP 使用底部抽屉，无横向溢出。

### P1：专业增强

- 更多指标：MA/EMA、VWAP、ATR、Stoch、ADX、OBV、Ichimoku、SuperTrend。
- 固定区间 Volume Profile：拖拽选择一段价格/时间范围，显示该区间分布。
- 指标模板：保存/载入指标组合，按品种切换。
- 画线持久化到 SQLite，支持多设备/多浏览器同步。
- 快捷键面板、画线撤销/重做、磁吸模式提示。
- 图表内事件回放（按 triggerAt 定位到规则触发点）。
- 多图对比（同屏 2 个品种或不同周期）。
- 导出 PNG/CSV；图表主题切换（深色/浅色）。

### 非目标

- 不接交易账户、不下单。
- 不实现完整 TradingView 级别的所有画线/指标脚本语言。
- 不引入云端图表服务；仍以本地单用户、OKX 公共行情为前提。
- P0 不承诺“指标脚本用户自定义执行”；只提供受控的指标目录和参数。

## 4. 页面与交互设计

### 4.1 信息架构

新增顶部/侧边导航项 **图表**：

```text
总览 | 图表 | 规则 | 事件 | 设置
```

总览保留一个紧凑图表卡片，右上角增加：

```text
[专业图表 →]
```

点击后跳到：

```text
/chart?symbol=BTC-USDT-SWAP&timeframe=5m
```

### 4.2 桌面布局

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ 图表  BTC-USDT-SWAP ▾  5m ▾  K线  指标 ▾  画线 ▾  VP  截图  全屏  重置    │
├──────┬───────────────────────────────────────────────────┬───────────────┤
│ 工具 │                                                   │ 价格轴        │
│ 栏   │                K 线主图 + 触发标记                │  + VP 侧边条  │
│      │                                                   │               │
│ 光标 │                                                   │  POC/VAH/VAL  │
│ 趋势 │                                                   │               │
│ 水平 │                                                   │               │
│ 斐波 │                                                   │               │
│ 文字 ├───────────────────────────────────────────────────┤               │
│ 画笔 │ 成交量 pane                                       │               │
│      ├───────────────────────────────────────────────────┤               │
│      │ RSI / MACD / KDJ pane（可调整高度）               │               │
├──────┴───────────────────────────────────────────────────┴───────────────┤
│ 时间轴       O/H/L/C  VOL  +2.34%   规则触发 2 个      数据延迟 320 ms      │
└──────────────────────────────────────────────────────────────────────────┘
```

关键交互：

- 十字光标联动所有 pane；主图左上角显示 OHLCV、涨跌幅、当前指标值。
- 滚轮围绕鼠标位置缩放；拖拽平移；`Shift + 滚轮` 水平滚动；双击复位。
- 主图右侧价格轴可拖拽调整比例；pane 分隔条可拖动。
- 画线工具选中后进入绘制模式，ESC 取消；右键删除，支持锁定。
- 触发标记 hover 显示规则名/触发价/时间；click 打开事件 drawer。
- 图表配置变更即时保存，刷新页面恢复。
- 移动端：顶栏变为两行或横向滚动；画线工具放进底部抽屉；图表高度使用 `100dvh` 减去导航和工具栏。

### 4.3 页面状态

- URL 保存 symbol/timeframe，便于刷新、分享（本地）和从事件页跳转。
- 图表加载中、数据不足、行情断开、指标计算错误分别显示 banner，不能把空图伪装成“正常”。
- 图表渲染失败时回退到现有 ECharts 小图或显示错误卡片，不影响规则页面。

## 5. 技术架构

### 5.1 前端组件

建议新增：

```text
src/web/pages/ChartPage.tsx
src/web/components/chart/ProChart.tsx
src/web/components/chart/ChartToolbar.tsx
src/web/components/chart/IndicatorManager.tsx
src/web/components/chart/DrawingToolbar.tsx
src/web/components/chart/VolumeProfileLegend.tsx
src/web/components/chart/ChartSettingsSheet.tsx
src/web/lib/chart/dataLoader.ts
src/web/lib/chart/indicatorRegistry.ts
src/web/lib/chart/volumeProfile.ts
src/web/lib/chart/drawings.ts
src/web/lib/chart/persistence.ts
src/web/lib/chart/types.ts
src/web/styles/chart.css
```

并逐步调整：

- `src/web/components/MarketChart.tsx`：从 ECharts 实现改为 KLineChart 的 compact 包装，或只保留给旧页面直到迁移完成。
- `src/web/pages/DashboardPage.tsx`：移除 15 秒轮询，改为图表组件内部实时订阅；增加“专业图表”入口。
- `src/web/components/TrialModal.tsx`：之后复用 compact 图表，保留触发标记。
- `src/web/App.tsx`：增加 `/chart` 路由和导航项。
- `src/server/api/routes.ts`：K 线分页和 SSE。
- `src/server/store.ts`：`getCandlesBefore`。
- `src/server/market/service.ts`：提供按时间范围/最新形成 K 线的读取能力。
- `src/shared/indicators/`：把纯指标公式从 `src/server/indicators.ts` 抽到共享层，服务端 re-export，前端和 KLineChart 共用。

### 5.2 生命周期

`ProChart` 只负责 chart 实例生命周期；React state 只保存配置和 UI，不把每根 K 线放进 React state：

```text
ChartPage (symbol/timeframe/settings)
   │
   ├─ ChartToolbar (React)
   ├─ DrawingToolbar (React)
   ├─ ProChart
   │    ├─ init(container)          // 只执行一次
   │    ├─ setSymbol / setPeriod    // props 变化时
   │    ├─ setDataLoader            // 初始化时设置
   │    ├─ registerIndicators       // 模块加载时一次
   │    ├─ createIndicator ...      // 配置变化时
   │    ├─ createOverlay ...        // 画线/标记变化时
   │    └─ subscribeAction(...)    // 十字光标/可视区
   └─ VolumeProfileLegend (可选 DOM 读数)
```

要点：

- 不在每次 crosshair/tick 时 setState 整张图；高频数据直接推给 KLineChart。
- 参数/指标配置变化通过 `overrideIndicator` / `removeIndicator` / `createIndicator` 更新，不重建 chart。
- 组件卸载时 `dispose(container)`，并清理 SSE、ResizeObserver、订阅。
- 使用 `ResizeObserver` 调 `chart.resize()`。
- 容器必须有明确高度，不能用 `height:auto`。

### 5.3 技术选型与版本

- `klinecharts`：锁定 `10.1.0`（当前最新 10.1.x；v10 与 v9 API 不兼容）。
- 移除 `echarts` 放到迁移完成后的独立阶段，避免一次性改坏总览和试跑。
- 不引入 `react-klinecharts` 等薄包装；直接使用 KLineChart API，减少封装层和版本风险。
- 增加第三方许可说明（Apache-2.0 的 NOTICE/LICENSE 归属）；不改项目整体 MIT 许可。
- 若团队最终更偏好 Lightweight Charts，需要额外接受：TradingView 归属要求、画线/指标/VP 全部自研；本方案不采用。

## 6. 数据层设计

### 6.1 K 线映射

KLineChart 的 `KLineData`：

```ts
type KLineData = {
  timestamp: number; // ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  turnover?: number;
};
```

映射本项目 `Candle`：

```ts
function toKLineData(c: Candle): KLineData {
  return {
    timestamp: c.openTime,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volCcyQuote, // 统一使用报价货币成交额
    turnover: c.volCcyQuote,
  };
}
```

约定：

- 所有价格/成交量必须转成 number；空值先丢弃，不允许把 `null` 塞入 KLineChart。
- 按 `timestamp` 升序；以 `timestamp` 去重。
- 形成中的 K 线和已收盘 K 线使用同一个 timestamp；KLineChart 会用 `subscribeBar` 覆盖最后一根，不会重复。
- 成交量统一用 `volCcyQuote`，图例显示“成交额（USDT）”；若后续要看币量，再加切换。

### 6.2 历史分页 API

当前 `GET /api/candles` 只支持 `limit`，不足以支撑向左拖动加载。

新增：

```http
GET /api/candles?instId=BTC-USDT-SWAP&timeframe=5m&limit=500&before=1763000000000
```

返回：

```json
{
  "instId": "BTC-USDT-SWAP",
  "timeframe": "5m",
  "candles": [ ... ],
  "page": {
    "hasMore": true,
    "oldest": 1760000000000,
    "newest": 1763000000000
  }
}
```

语义：

- 不传 `before`：返回最新一页（含 forming bar，保持现有总览行为）。
- 传 `before`：返回 `openTime < before` 的更早一页，用于 `getBars({ type: 'forward' })`。
- `limit` 上限从 500 提升到 1,000；专业图表默认 500。
- 分页不返回重复 timestamp；服务端按 `openTime DESC` 取数后反转。
- 历史数据优先从 SQLite 读取；数据不足时调用 OKX 历史接口并落库。
- 对 `instId`、`timeframe`、`limit` 做白名单/范围校验，避免任意查询。

实现点：

- `Store.getCandlesBefore(instId, timeframe, before, limit)`。
- `MarketService` 暴露“读取历史 + 当前 forming”的能力；不要只依赖内存里的 300 根。
- 现有 `getCandlesIncludingForming` 保留给总览/规则，新增 `getCandlePage` 或直接 store 查询 + forming 拼接。
- 每页最多 1,000 根，单图最多加载 5,000 根，防止内存和渲染压力。

### 6.3 实时 K 线

不建议继续每 15 秒轮询 240 根。新增轻量 SSE：

```http
GET /api/candles/stream?instId=BTC-USDT-SWAP&timeframe=5m
```

```text
event: candle
data: {"candle":{"instId":"BTC-USDT-SWAP","timeframe":"5m","openTime":...,"open":...,"high":...,"low":...,"close":...,"volume":...,"confirm":false}}

event: heartbeat
data: {"now":...}
```

实现策略：

- 连接建立时先推送当前 latest closed/forming K 线快照。
- 服务端监听 `market` 的 `tick` / `closed`，按 symbol/timeframe 过滤；每 250ms 节流，避免每个成交都写网络。
- SSE 断开时前端自动重连；重连后重新推快照，KLineChart 用同一 timestamp 覆盖。
- 若 SSE 不可用，降级为 2 秒轮询 `limit=2`，不阻塞图表。
- 不建议让浏览器直接连 OKX WebSocket，避免把凭证/限流/重连逻辑散落到前端。
- 现有全局 SSE `refresh` 继续用于规则/事件/设置，不把 K 线混进全局刷新流。

### 6.4 规则触发标记

使用 KLineChart 的 overlay，而不是绘制在 React DOM 上：

- 触发标记：`simpleAnnotation` / `simpleTag`，points 为 `{ timestamp: event.triggerAt, value: event.price }`。
- 数据来源：`GET /api/events?symbol=...&from=...&to=...&limit=200`；无 timeframe 参数时按 symbol+时间范围取，标记按触发时间定位。
- 点击标记时打开事件 drawer；如果 KLineChart overlay 点击事件不满足，回退到 `onCandleBarClick` + 最近事件索引。
- 触发标记与用户画线分开 `groupId`，清空画线不影响标记。
- 标记只渲染可视区，避免一次性创建数百个 overlay。

## 7. 指标系统

### 7.1 公式一致性

规则引擎和图表必须使用同一套公式，否则会出现“图上看起来满足、规则却不触发”。

建议重构：

```text
src/shared/indicators/      纯函数：sma, ema, bollingerBands, kdj, rsi, macd, volumeMovingAverage...
src/server/indicators.ts     re-export + 规则引擎需要的 computeSeries
src/web/lib/chart/indicatorRegistry.ts
```

KLineChart 自定义指标示例（概念代码）：

```ts
registerIndicator({
  name: 'MS_BOLL',
  shortName: 'BOLL',
  series: 'price',
  calcParams: [20, 2],
  figures: [
    { key: 'upper', title: 'UP:', type: 'line', styles: { color: '#71a7ff' } },
    { key: 'middle', title: 'MID:', type: 'line', styles: { color: '#9e8cff', style: 'dashed' } },
    { key: 'lower', title: 'LOW:', type: 'line', styles: { color: '#71a7ff' } },
  ],
  calc: (dataList, indicator) => {
    const candles = dataList.map((bar) => ({
      open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume ?? 0,
    }));
    const bands = bollingerBands(candles, {
      length: indicator.calcParams[0],
      mult: indicator.calcParams[1],
    });
    return bands.upper.map((_, i) => ({ upper: bands.upper[i], middle: bands.middle[i], lower: bands.lower[i] }));
  },
});
```

所有自定义指标都做同样的事：

- `series` 设为 `price` 或 `volume`，让精度跟随品种。
- `calcParams` 对外暴露参数，`registerIndicator` 允许参数修改。
- `figures` 颜色/线宽/虚线统一由主题生成，不硬编码散落。
- 每次 `calc` 必须纯函数，不读 DOM/localStorage/网络。

### 7.2 指标目录

P0：

| 指标 | Pane | 说明 |
|---|---|---|
| BOLL | 主图 overlay | 与规则公式一致 |
| VOL | 成交量 pane | 成交额柱 + MA |
| KDJ | 子 pane | K/D/J + 20/80 参考线 |
| RSI | 子 pane | 与规则公式一致 + 30/70 |
| MACD | 子 pane | DIF/DEA/Histogram + 零轴 |
| MA | 主图 overlay | 5/10/20/60 可配置 |
| Volume Profile | 主图右侧 overlay | 可见范围分布 |

P1：EMA、VWAP、ATR、Stoch、ADX、OBV、Ichimoku、SuperTrend、Donchian 等。指标用“目录注册表”描述，不在页面里写 if/else：

```ts
type IndicatorDefinition = {
  id: string;
  name: string;
  category: 'trend' | 'momentum' | 'volatility' | 'volume';
  defaultParams: number[];
  pane: 'main' | 'sub';
  create(): void;
};
```

### 7.3 指标管理器

- 点击“指标”打开抽屉：分类列表、搜索、已启用指标。
- 已启用项支持参数编辑、显示/隐藏、上移/下移 pane、删除。
- pane 顺序在 localStorage 保存；切换品种保留全局布局。
- 参数变化调用 `overrideIndicator`；不要重建整个 chart。
- 设置版本升级：`market-sentinel.chart-indicators.v1` → `market-sentinel.chart-workspace.v1`，提供 v1 → v2 迁移，旧用户 BOLL/VOL 配置不丢。

## 8. Volume Profile 设计

### 8.1 产品定义

侧边成交量分布图（Volume Profile）显示当前可见时间范围内，各价格区间的成交量。P0 只做 **Visible Range Profile**；Fixed Range / Session Profile 放到 P1。

展示：

- 主图右侧水平柱状条，最大宽度约主图宽度的 18%。
- 总量 / 上涨量 / 下跌量可切换；默认用总成交额。
- POC（成交量最大价位）高亮线。
- 价值区（Value Area，70%）的 VAH/VAL 线，可开关。
- 图例显示 `POC ≈ 68,420 · VA 67,900–69,100`。
- Hover 某一价格桶显示区间/成交量/占比（P1 可做）。

### 8.2 算法

```ts
type ProfileBin = { low: number; high: number; volume: number; up: number; down: number };

function buildVolumeProfile(candles: Candle[], binCount = 80): VolumeProfile {
  const min = Math.min(...candles.map((c) => c.low));
  const max = Math.max(...candles.map((c) => c.high));
  const step = (max - min) / binCount || 1;
  const bins = Array.from({ length: binCount }, (_, i) => ({
    low: min + i * step,
    high: min + (i + 1) * step,
    volume: 0, up: 0, down: 0,
  }));

  for (const c of candles) {
    const lo = Math.max(0, Math.floor((c.low - min) / step));
    const hi = Math.min(binCount - 1, Math.floor((c.high - min) / step));
    const span = hi - lo + 1;
    const per = c.volCcyQuote / span;
    for (let i = lo; i <= hi; i++) {
      bins[i].volume += per;
      if (c.close >= c.open) bins[i].up += per;
      else bins[i].down += per;
    }
  }

  const pocIndex = bins.reduce((best, b, i) => (b.volume > bins[best].volume ? i : best), 0);
  // 从 POC 向两侧扩张，直到累计达到总量 70%，得到 valueLow/valueHigh
  return { bins, poc: ..., valueLow: ..., valueHigh: ... };
}
```

实现约定：

- 使用 `volCcyQuote`（报价货币成交额），与图表成交量一致。
- 每根 K 线成交量在其 high-low 区间均匀分配；这是可解释的近似，后续可切 “按收盘价分配/按成交量加权” 模式。
- 复杂度 `O(candles × bins)`；500 根 × 80 桶约 4 万次运算，可忽略。
- 缓存键：`symbol + timeframe + visibleRange + binCount + volumeMode`；只有可视区/参数变化才重算。
- 空数组、`high === low`、零成交量要有保护，不能产生 NaN。

### 8.3 渲染

首选 **KLineChart 自定义 overlay**：

- 注册 `volumeProfile` overlay（`lock: true`，不允许拖动）。
- 在 `createPointFigures` 中读取 `chart.getVisibleRange()` 和 `chart.getDataList()`。
- 用 `chart.convertToPixel({ value: bin.mid }, { paneId: 'candle_pane' })` 得到 y；右边界使用 overlay 的 `bounding` 或 `chart.getSize()`。
- 返回 `rect` 数组（每个价格桶一条），以及 POC/VAH/VAL 的 `line` 和 `text` figures。
- 可视区变化通过 `subscribeAction('onVisibleRangeChange')` 触发重绘；若 overlay 没有自动重绘，则 `overrideOverlay` 更新一个内部版本字段。
- POC/VAH/VAL 的 DOM 图例由 React 渲染，避免把文字塞满 canvas。

如果 spike 发现自定义 overlay 在缩放/重绘时不稳定，采用 **备选方案**：

- 在主图右侧放同步 canvas，监听 `onVisibleRangeChange`、`onZoom`、`onScroll` 和 ResizeObserver。
- 用 `convertToPixel` 对齐 y 坐标；这是更可控但多一层同步的兜底。
- 该方案不影响指标/数据层设计。

### 8.4 后续扩展

- Fixed Range：用户用画线选一个时间/价格矩形，显示该区间 profile。
- Session：按 UTC+8 交易时段或每日会话聚合。
- 筹码分布：按持仓成本/换手率近似（需要额外数据，暂不做）。
- 上涨/下跌量、Delta、POC 迁移路径。


## 8.5 价格层级数据：从 Volume Profile 到清算/订单簿

这一节回答一个容易混淆的问题：**KLineChart 能否在价格轴上纵向展示清算、成交量、订单簿等数据？**

可以，而且这是它比普通“指标库”更适合本项目的地方；但要选对扩展点：

- `registerIndicator` 是**按 K 线时间点计算序列**，适合 RSI/MACD/BOLL。
- `registerOverlay` 是**在价格/时间坐标里画任意图形**，适合价格层级柱、清算簇、订单簿深度、POC/VA 线。
- `registerFigure` 是更低层的 canvas 图元，适合需要自行绘制复杂图形的 heatmap。

“价格层级上的数据”通常不是一条随时间变化的指标，而是：

```ts
type PriceLevelDatum = {
  price: number;
  value: number;
  side?: 'long' | 'short';
  label?: string;
  timestamp?: number;
};

type PriceLevelSeries = {
  id: string;
  label: string;
  unit: 'USDT' | 'BTC' | 'contracts' | 'percent';
  mode: 'histogram' | 'levels' | 'heatmap';
  data: PriceLevelDatum[];
  updatedAt: number;
  source: 'derived' | 'okx' | 'onchain' | 'third-party';
};
```

因此，正确架构是 **PriceLevelOverlay + Data Provider**，而不是把清算数据伪装成普通技术指标。

### 8.5.1 可展示的数据类型

| 数据 | 形态 | 数据来源 | 当前项目可行性 |
|---|---|---|---|
| Volume Profile | 价格桶成交量柱 | K 线 + `volCcyQuote` 派生 | 高，已在 P0 方案中 |
| 订单簿深度/挂单墙 | 价格档位挂单量柱 | OKX 公共 order book | 高，需要快照/增量订阅 |
| OKX 强平成交 | 价格桶强平名义金额 | OKX 公共 WebSocket 的 liquidation orders 频道 | 中高，需实现/验证频道 |
| 链上借贷协议清算 | 价格桶清算事件/名义金额 | Aave/Compound 等 RPC/索引器 | 中低，数据分散、需节点/indexer |
| 清算热力图 | 时间 × 价格二维强度 | Coinglass 等第三方，通常是估算/聚合 | 低（付费/授权/口径不透明） |
| BTC 链上成本/筹码分布 | 价格桶供应量 | Glassnode 等第三方或 UTXO 索引 | 低（付费/重数据） |

**必须区分三个概念：**

1. **OKX 强平成交**：OKX 自己撮合的强平/ADL 成交，只代表 OKX，不能叫“全市场链上清算”。
2. **链上协议清算**：Aave/Compound 等合约事件，真实但跨链、跨协议、事件稀疏；要映射到对应 CEX 合约价格和 USD 名义金额。
3. **清算热力图**：通常是第三方基于杠杆、持仓量、价格区间推算的“估算清算簇”，不是逐笔链上清算，展示时必须标注“估算”。

如果产品文案写“链上清算”，但数据其实是 OKX 强平或第三方热力图，会误导用户；建议在图层标题/图例中明确 `OKX 强平`、`协议清算`、`估算热力图`。

### 8.5.2 Provider 接口

把“取数”和“绘制”彻底分开：

```ts
interface PriceLevelProvider {
  id: string;
  label: string;
  source: 'derived' | 'okx' | 'onchain' | 'third-party';
  unit: PriceLevelSeries['unit'];
  getSnapshot(params: {
    symbol: string;
    timeframe: Timeframe;
    from: number;
    to: number;
    priceRange: { min: number; max: number };
  }): Promise<PriceLevelSeries> | PriceLevelSeries;
  subscribe?(
    params: { symbol: string; timeframe: Timeframe },
    onUpdate: (series: PriceLevelSeries) => void,
  ): () => void;
}
```

首批 provider：

```text
VolumeProfileProvider   // 从当前图表 K 线派生，不需要额外网络
OrderBookDepthProvider  // OKX books / books5 公共频道或 REST 快照
OkxLiquidationProvider  // OKX liquidation-orders 频道
OnchainLiquidationProvider // 预留，选择数据商/索引器后再实现
```

Provider 的输出只包含“价格 → 数值”的归一化序列；Overlay 不关心数据来自哪里。这样以后从 OKX 强平切换到第三方链上数据，不需要改图表层。

### 8.5.3 动态更新

KLineChart overlay 没有 React 式的数据绑定，需要自己管理快照和刷新，但这正好适合高频数据：

```text
OKX WS / 第三方 WS / REST
        │
        ▼
PriceLevelStore（环形缓冲 + 价格桶聚合 + 去重）
        │  250ms / 1s 节流快照
        ▼
PriceLevelOverlay（当前可见范围 + 当前价格轴）
        │  overrideOverlay / 内部版本号触发重绘
        ▼
KLineChart canvas
```

原则：

- 不重建 chart；只更新 overlay 或重算快照。
- 高频清算/订单簿数据不要每笔都 React setState；放外部 store，按 250–1000ms 合并。
- 可视区变化（`onVisibleRangeChange`/`onZoom`/`onScroll`）只重算当前价格范围内的桶。
- 价格桶数量控制在 60–200；heatmap 控制在合理网格（例如 80 × 120），否则 canvas 图元数量会快速上升。
- 数据时间戳/来源/延迟显示在图例中；超过阈值显示“数据过期”，不能把旧快照当实时。
- 右侧价格轴仍由 K 线决定；超出当前可视价格区间的清算档位不要强行拉伸坐标轴，显示“区间外 N 档”或让用户缩放查看。

### 8.5.4 渲染方式

**A. 价格桶直方图**（Volume Profile、强平金额、订单簿深度）

- 自定义 overlay，`paneId: 'candle_pane'`，`lock: true`。
- 用 `chart.convertToPixel({ value: bin.mid }, { paneId: 'candle_pane' })` 得到 y。
- 返回 `rect` figures，宽度按 `value/maxValue` 归一化，从右侧向左画。
- 多头/空头用不同颜色，POC/最大档位高亮。
- 只对需要交互的档位设置 `ignoreEvent`/事件处理；其余不拦截十字光标。

**B. 价格水平线/标签**（大额清算线、鲸鱼挂单）

- 一条 `line` + `text`；数量少时最稳。
- 点击标签打开详情/过滤事件；不要每根线一个 overlay 实例，建议批量在一个 overlay 中画多组 figure。

**C. 时间 × 价格 heatmap**（清算热力图）

- 这是唯一需要谨慎的场景。几百个 `rect` 还可以；`100 时间列 × 100 价格桶 = 10,000` 个 rect 会明显拖慢 canvas。
- 首选：`registerFigure` 自定义 canvas 图元，一次 `ctx.fillRect` 批量绘制，KLineChart 只负责坐标和重绘调度。
- 备选：独立 overlay canvas，监听可视区变化，用 `convertToPixel` 对齐价格轴；实现更可控。
- 如果数据商只给静态图片/瓦片，直接作为背景层，不强行转成 K 线数据。

### 8.5.5 分阶段落地

| 阶段 | 内容 | 说明 |
|---|---|---|
| A | Volume Profile overlay | 已验证价格轴对齐、可视区重算、POC/VA，作为 PriceLevelOverlay 基座 |
| B | Order Book Depth | OKX 公共 order book，快照 + 节流；展示买卖挂单墙 |
| C | OKX 强平 | 接入 OKX liquidation-orders，按价格桶/时间窗聚合，明确标注“OKX 强平” |
| D | 链上协议清算 | 先确定数据商或自建索引器；输出同样 PriceLevelSeries，不改图表 |
| E | 清算 heatmap | 单独做 canvas 图元/图层，性能验收后再上线 |

不建议第一版同时做“链上 + 多交易所 + 热力图”；先把 Volume Profile 和订单簿深度跑通，再按数据质量逐个接入。

### 8.5.6 需要提前确认的数据问题

- “链上清算”具体指 Aave/Compound 的真实清算事件，还是 Coinglass 式估算清算热力图？
- 是否接受接入付费第三方 API？这会改变当前“无 API Key”的产品定位。
- 只针对 BTC/ETH，还是所有 OKX 合约？链上资产与合约标的的映射需要单独维护。
- 数据延迟容忍度：交易所强平可以秒级，链上事件受区块确认影响；两种数据不能共用“实时”标签。
- 是否需要历史回放？历史链上清算数据通常比实时数据更贵/更难获得。

## 9. 画线与标记

### 9.1 画线工具

直接使用 KLineChart 内置 overlay：

- `segment`（趋势线段）
- `straightLine` / `rayLine`
- `horizontalStraightLine` / `horizontalRayLine` / `horizontalSegment`
- `priceChannelLine`
- `fibonacciLine`
- `simpleAnnotation` / `simpleTag`（文字/标记）
- `brush`（画笔）

工具栏行为：

- 点击工具 → `chart.createOverlay({ name, paneId: 'candle_pane' })` → 进入交互绘制。
- ESC/再次点击取消；绘制完成恢复光标。
- 右键删除；工具栏提供“清空画线”；可选撤销/重做（P1）。
- 画线数据用 `getOverlays()` 读取 `points/styles/lock/groupId`，写入 localStorage。

### 9.2 规则触发 overlay

- `groupId: 'rule-events'`，每条标记一个 `simpleAnnotation`，`lock: true`。
- 只渲染可视区 + 200 根范围内的事件；切换 symbol 时重建。
- 标记颜色：收盘触发/盘中触发区分；点击打开事件 drawer。
- 触发标记与用户画线分开，清空画线不影响规则标记。

### 9.3 持久化

P0 localStorage：

```ts
type ChartWorkspaceState = {
  version: 1;
  symbol: string;
  timeframe: Timeframe;
  indicators: IndicatorInstance[];
  drawings: Record<string, SerializedOverlay[]>; // key: symbol|timeframe
  volumeProfile: { enabled: boolean; bins: number; mode: 'visible' | 'fixed'; ... };
};
```

- 所有输入经过 schema/边界清洗，防止旧配置/恶意 localStorage 破坏图表。
- 版本迁移：v1 指标配置 → v2；失败回退默认值。
- P1 增加 `chart_drawings` SQLite 表或 `/api/chart-settings`，实现多浏览器同步。

## 10. 后端改动清单

| 文件 | 改动 |
|---|---|
| `src/server/store.ts` | 新增 `getCandlesBefore`；按周期调整 K 线保留策略 |
| `src/server/market/service.ts` | 暴露分页所需的历史读取；保留 forming bar 读取 |
| `src/server/api/routes.ts` | `/api/candles` 增加 `before`/`page`；新增 `/api/candles/stream` SSE；校验上限 |
| `src/server/api/routes.ts` | 事件标记复用现有 `/api/events` 过滤（symbol/from/to/limit） |
| `src/server/config.ts` | 如需要，增加 K 线分页/保留配置（可选） |
| `src/shared/indicators/` | 从 `src/server/indicators.ts` 抽纯公式，server re-export |
| `src/web/App.tsx` | 新增 `/chart` 路由和导航项 |
| `src/web/pages/DashboardPage.tsx` | 增加专业图表入口；移除 15s 轮询（迁移后） |
| `src/web/components/MarketChart.tsx` | 逐步替换为 KLineChart compact 模式 |
| `src/web/components/TrialModal.tsx` | 迁移到 compact 图表，保留触发点 |
| `package.json` | 增加 `klinecharts@10.1.0`；ECharts 迁移完成后移除 |

### 数据保留

当前清理策略是 1m 7 天、3m 14 天、其他 90 天。专业图表需要更长历史，建议：

- 1m：7 天
- 3m：14 天
- 5m–30m：90 天
- 1H–4H：365 天
- 1D：730 天（或至少 365 天）

如果暂时不改保留策略，`/chart` 的 1D 视图只能显示约 90 根；这需要在 P0 验收时明确，或者首版只加载 OKX 历史接口的 300 根 1D。

## 11. 性能与包体

目标：

- 初始 500 根、5 个指标、Volume Profile，桌面端 1 秒内可交互（本地环境）。
- 拖动/缩放 60fps 目标；至少不阻塞输入。
- 最多 5,000 根前端数据；超过则丢弃最旧或提示“重置到最新”。
- 不在 React state 保存 tick 数据；不对每根 K 线重建 series。
- Volume Profile 只在可视区/参数变化时重算，使用 Float64Array 或普通数组缓存。
- 图表页面 `React.lazy` 加载；KLineChart 只在该路由加载。
- 移除 ECharts 后，前端主包预计减少约 700 KB 以上（最终以构建分析为准）。
- `npm run build` 产物体积纳入验收。

## 12. 测试策略

### 单元测试

- `toKLineData`：数值转换、排序、去重、空值丢弃。
- 分页合并：`init/forward`、边界、`hasMore=false`、并发请求只保留最新。
- 指标 parity：同一组 K 线，KLineChart 自定义指标输出 vs `src/server/indicators.ts` 输出，误差 `< 1e-8`。
- Volume Profile：已知 3–5 根蜡烛的 POC/VAH/VAL、零成交量、单价位、分箱边界。
- 画线序列化/恢复、localStorage 版本迁移。
- 指标配置 schema 边界。

### 集成测试

- `/api/candles?before=` 分页、无重复、limit 上限、非法参数。
- `/api/candles/stream` 首帧/快照/断线重连/清理（用 fake market）。
- `/api/events` 时间范围标记查询。
- K 线保留策略。

### E2E

- 打开 `/chart`，默认 symbol/timeframe，500 根加载。
- 切换周期、搜索品种、URL 更新。
- 添加 RSI/MACD、修改参数、拖动 pane 高度、关闭指标。
- 向左拖动触发历史分页，不重复。
- 画趋势线、水平线、斐波那契；刷新后恢复；清空。
- 打开 Volume Profile，POC/VAH/VAL 显示；缩放后更新。
- 触发标记点击打开事件详情。
- 移动端 390px：工具栏可滚动、无横向溢出、图表/抽屉可用。
- 现有 9 个 E2E 和总览/试跑图表不回归。

### 视觉/性能

- Playwright 截图对比（深色主题、桌面/移动、VP 开/关）。
- 5000 根 K 线 + 5 指标 + VP 的加载/交互基准，记录在性能回归中。
- 无 console error/page error。

## 13. 分阶段实施

以 1 名熟悉前端/金融图表的开发者为估算：

| 阶段 | 内容 | 估算 | 验收 |
|---|---|---:|---|
| 0. Spike | KLineChart 接入、500 根、K 线/平移缩放、自定义 BOLL、VP overlay 原型 | 1–2 天 | 能证明 KLineChart + VP 可行；决定是否继续 |
| 1. 数据与页面骨架 | `/chart`、API 分页、SSE、工具栏、symbol/timeframe、总览入口 | 4–5 天 | 500 根加载、向左分页、实时最后一根更新 |
| 2. 指标系统 | 共享公式、5 个 P0 指标、指标管理器、pane、localStorage | 3–4 天 | 指标与规则公式一致；增删/参数/排序可用 |
| 3. 画线与标记 | 工具栏、内置 overlay、持久化、规则标记、截图 | 3–4 天 | 画线刷新恢复；标记点击打开事件 |
| 4. Volume Profile | 算法、overlay、POC/VA、缓存、图例、响应式 | 3–5 天 | 可视区变化正确重绘；性能可接受 |
| 5. 收尾/迁移 | 移动端、主题、快捷键、TrialModal/Dashboard 迁移、移除 ECharts、文档/测试 | 3–4 天 | 总览/试跑不回归；包体下降；E2E 全绿 |

**P0 可用版本约 2.5–3 周；完整 P0+P1 约 4–5 周。**

## 14. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| KLineChart 自定义 overlay 在缩放/重绘时行为不符合预期 | Volume Profile 延误 | 阶段 0 先做 spike；准备右侧同步 canvas 备选 |
| 指标公式与 KLineChart 内置公式不一致 | 图上与规则不一致 | 不用内置公式做规则相关指标，统一走共享自定义指标；parity 测试 |
| 1D/长周期历史不足 | 专业图表“只能看 90 天” | 调整保留策略；历史 API 按需回填；在验收中明确上限 |
| 实时 tick 导致 React/canvas 抖动 | 交互卡顿 | tick 只走 KLineChart 回调；250ms 节流；不在 React state 存 bar |
| ECharts 移除导致总览/试跑回归 | 现有功能受影响 | 独立 `/chart` 先行；compact 图表迁移后再删依赖；E2E 双覆盖 |
| 画线/指标本地存储版本碎片 | 用户配置丢失 | schema 版本 + 迁移 + 默认回退；导出/导入 P1 |
| v10 API 破坏性变更 | 升级成本 | 锁定 10.1.0；封装只暴露项目 API；升级前跑视觉/行为回归 |
| 移动端画线体验差 | 手机不可用 | 工具底部抽屉、触摸手势、触控目标 ≥ 40px；390px E2E |
| 许可证/归属遗漏 | 合规风险 | 保留 Apache-2.0 NOTICE；不使用 TradingView 受限库；README 第三方依赖说明 |

## 15. 验收标准

P0 完成时：

1. `/chart` 在桌面和 390px 手机可用，无横向溢出。
2. 默认加载 500 根，向左拖动可加载更早数据，无重复/无丢 K 线。
3. 当前最新一根 K 线在 1 秒级刷新（SSE 或降级轮询），形成中 K 线不闪烁。
4. BOLL/VOL/KDJ/RSI/MACD 与规则公式一致（自动 parity 测试）。
5. 指标支持开关、参数、pane 高度；刷新后配置保留。
6. Volume Profile 显示 POC/VAH/VAL，缩放后重算正确。
7. 可绘制趋势线/水平线/斐波那契并持久化；规则标记可点击。
8. 现有 113 个单元/集成测试和 9 个 E2E 不回归；新增图表 E2E 全绿。
9. 前端构建体积不高于当前；ECharts 移除后明显下降。
10. 无 console error；图表异常有可见错误态。

## 16. 需要确认的决策

建议默认采用：

1. **图表内核：KLineChart 10.1.x**（而不是 Lightweight Charts / TradingView 授权库）。
2. **页面形态：新增 `/chart` 专业页**，总览保留紧凑图；验证后再统一。
3. **P0 Volume Profile：可见范围模式**；固定区间/会话模式放 P1。
4. **画线/配置 P0 存 localStorage**；P1 再做 SQLite 同步。
5. **P0 指标：现有 5 个 + MA**；更多指标放 P1。

如果以上确认，下一步先做 **阶段 0 Spike**：只接入 KLineChart、500 根数据、一个自定义 BOLL 和 Volume Profile 原型，不删除现有 ECharts、不改总览，验证通过后再进入阶段 1。

## 17. 参考资料

- KLineChart 官网：<https://klinecharts.com/>
- KLineChart 数据接入（v10 `setDataLoader`）：<https://klinecharts.com/en-US/guide/data-integration>
- KLineChart 自定义指标：<https://klinecharts.com/en-US/guide/indicator>
- KLineChart 自定义 overlay：<https://klinecharts.com/en-US/guide/overlay>
- KLineChart Figure / rect：<https://klinecharts.com/en-US/guide/figure>
- KLineChart API `convertToPixel`：<https://klinecharts.com/en-US/api/instance/convertToPixel>
- OKX API 公共数据：<https://www.okx.com/docs-v5/en/#public-data-websocket>
- KLineChart GitHub（Apache-2.0）：<https://github.com/klinecharts/KLineChart>
- TradingView Lightweight Charts 文档（对比参考）：<https://tradingview.github.io/lightweight-charts/docs>
- TradingView Lightweight Charts 归属要求：<https://tradingview.github.io/lightweight-charts/docs#license-and-attribution>
