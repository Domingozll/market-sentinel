# 专业 K 线工作台 v1.0 — 产品技术实现规范

> 交付对象：开发 Agent  
> 状态：v1.0 implemented（2026-11-15；v1.1 价格层级 Provider 仍为后续范围）  
> 版本：v1.0  
> 依赖设计：[CHART_WORKSPACE_DESIGN.md](./CHART_WORKSPACE_DESIGN.md)  
> 本文是 v1.0 的实现契约和验收依据；设计文档用于理解背景和未来扩展。  
> 本次只实现本文件 **v1.0 范围**。v1.1/P1 的价格层级数据（订单簿、OKX 强平、链上清算、热力图）不在本次验收内，详见第 15 节。

## 0. 开发 Agent 先读这一段

1. **不要一次性替换现有 ECharts 总览图。** v1.0 新增 `/chart` 专业图表页，总览和试跑继续使用现有 ECharts `MarketChart`。
2. **不要接入真实链上清算数据。** v1.0 只做从 K 线派生的 Volume Profile；订单簿、OKX 强平和链上数据是 v1.1 的 Provider 扩展。
3. **先完成阶段 0 Spike。** 必须证明 KLineChart 10.1.0 能在当前 React 19 + Vite 8 + TypeScript 7 环境运行，并能用自定义 overlay 画出 Volume Profile，再进入全量开发。
4. **KLineChart v10 与 v9 API 不兼容。** 锁定 `klinecharts@10.1.0`；不要使用 `applyNewData` / `updateData` 等 v9 方法。
5. **不能破坏现有 113 个单元/集成测试和 9 个 E2E。** 新增功能放在独立路由和独立文件中，旧图表行为保持不变。
6. **所有指标公式以服务端共享公式为准。** 不允许图表自己复制一份 RSI/KDJ/MACD 算法。
7. **不要修改用户数据/规则/投递/通知逻辑。** 本功能只新增行情图表读取和前端展示能力，除非为实现分页/SSE 做必要的只读查询。

## 1. 背景与目标

### 1.1 背景

当前 `src/web/components/MarketChart.tsx` 使用 ECharts 6：

- 最多请求 240 根 K 线；
- 每 15 秒整页重新拉取；
- 支持固定的 BOLL、VOL、KDJ、RSI、MACD 开关；
- 没有拖拽加载历史、实时单根 K 线、十字光标读数、画线、指标管理器或 Volume Profile。

### 1.2 v1.0 目标

提供一个独立、专业、可扩展的 `/chart` 工作台：

- K 线流畅缩放/平移；
- 初始 500 根，向左继续分页；
- 形成中 K 线低频实时更新；
- 多 pane 技术指标，参数可编辑；
- 可画趋势线、水平线、斐波那契等；
- 侧边 Volume Profile（POC/VAH/VAL）；
- 规则触发标记；
- 桌面和移动端可用；
- 配置本地持久化；
- 为 v1.1 价格层级数据 Provider 留出接口。

### 1.3 非目标（v1.0 明确不做）

- 不实现真实链上清算、Coinglass 热力图、Aave/Compound 索引器。
- 不实现 OKX 强平/订单簿 overlay（只保留接口和未来文档）。
- 不实现多图对比、bar replay、下单、账户/API Key。
- 不实现用户自定义 JS/Pine 脚本。
- 不删除 ECharts，不迁移 TrialModal。
- 不做服务端画线同步（localStorage 即可）。
- 不实现完整 TradingView 的所有画线类型。

## 2. 决策记录

| 决策 | 结论 | 原因 |
|---|---|---|
| 图表内核 | **KLineChart 10.1.0** | Apache-2.0、50 KB gzip、内置画线/指标、v10 数据加载器 |
| 页面形态 | **新增 `/chart` 专业页** | 保留总览低风险；便于全屏和移动端 |
| 总览 | 继续使用 ECharts `MarketChart` | 降低 v1.0 回归风险 |
| 历史数据 | 初始 500，最大 5,000 根 | 覆盖日内到日线分析，同时限制内存 |
| 实时 | SSE 优先，2 秒轮询降级 | K 线必须及时更新，但不引入额外 WS 前端连接 |
| 指标 | 共享公式 + KLineChart custom indicator | 保证与规则引擎一致 |
| Volume Profile | 可见范围 + POC/70% VA | 第一版价值最高、算法可解释 |
| 画线/配置 | localStorage | 单用户本地应用，先不引入服务端 schema |
| v1.1 数据 | PriceLevelProvider 扩展 | 订单簿/OKX 强平/链上不阻塞 v1.0 |

## 3. 用户故事与验收目标

### 3.1 用户故事

- 作为交易者，我可以从总览进入专业图表，选择任意 OKX 品种和周期。
- 我可以缩放、平移、查看 OHLCV，并向左加载更多历史。
- 我可以添加/删除指标并修改参数，刷新后配置保留。
- 我可以在图表上画趋势线/水平线/Fibonacci，刷新后恢复。
- 我可以看到当前可见范围的成交量分布和 POC/VA。
- 我可以看到规则触发点，并打开对应事件。
- 我可以在手机上看图、切换周期、开合指标/画线工具，不出现横向溢出。
- 图表异常时我能看到明确错误/数据过期提示，而不是空白画布。

### 3.2 v1.0 验收门槛

必须同时满足：

1. `/chart` 在桌面 1440px 和手机 390px 可用。
2. 初始 500 根；向左拖动至少能加载 2 页历史，无重复 timestamp。
3. 最新一根 K 线在 SSE 连接时 1 秒内变化可见；断开后降级轮询仍可更新。
4. BOLL/VOL/KDJ/RSI/MACD 与共享公式输出一致（自动测试）。
5. 指标增删、参数修改、pane 高度调整可用，刷新后保留。
6. 趋势线/水平线/Fibonacci 可画、可删、刷新后恢复。
7. Volume Profile 显示 POC/VAH/VAL，缩放后 500ms 内更新。
8. 触发标记可点击查看事件信息。
9. 现有 113 个单元/集成测试和 9 个 E2E 全部通过。
10. `npm run typecheck`、`npm run build`、`npm audit` 通过；无 console error。

## 4. 信息架构与路由

### 4.1 导航

在 `src/web/App.tsx` 的导航中新增：

```text
总览 / 图表 / 规则 / 事件 / 设置
```

- 路由：`/chart`
- 图标：`CandlestickChart` 或 `LineChart`（lucide-react）。
- 移动端底部导航增加到 5 项；必须检查 390px 不溢出。
- 当前 nav 高亮逻辑：`/chart` 只高亮“图表”。

### 4.2 URL 状态

```text
/chart?symbol=BTC-USDT-SWAP&timeframe=5m
```

规则：

- `symbol` 必须匹配 `/^[A-Z0-9-]{3,40}$/`，否则回退 `BTC-USDT-SWAP`。
- `timeframe` 必须是 `TIMEFRAMES` 之一，否则回退 `5m`。
- 切换品种/周期使用 `history.replaceState` 或 React Router 的 `replace`，不新增浏览器历史。
- 页面刷新后从 URL 恢复。
- 总览“专业图表”按钮带上当前 symbol/timeframe。

### 4.3 总览入口

在 `src/web/pages/DashboardPage.tsx` 图表卡片工具栏增加：

```text
[专业图表 →]
```

- 仅新增入口，不修改现有图表逻辑。
- 点击：`navigate(`/chart?symbol=${encodeURIComponent(activeSymbol)}&timeframe=${encodeURIComponent(timeframe)}`)`。

## 5. UX / 页面布局

### 5.1 桌面布局

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ 专业图表  [BTC-USDT-SWAP ▾] [5m ▾] [指标 ▾] [画线 ▾] [VP] [截图] [全屏] │
├──────┬───────────────────────────────────────────────────┬───────────────┤
│ 工具 │                                                   │ 价格轴        │
│ 栏   │          K 线主图 + 触发标记 + VP 侧条             │               │
│      │                                                   │               │
│ 光标 │                                                   │               │
│ 趋势 │                                                   │               │
│ 水平 ├───────────────────────────────────────────────────┤               │
│ 斐波 │ 成交量 pane                                       │               │
│ 文字 ├───────────────────────────────────────────────────┤               │
│ 画笔 │ 指标 pane（可添加/调整高度）                      │               │
├──────┴───────────────────────────────────────────────────┴───────────────┤
│ 时间轴   O/H/L/C  VOL  +2.34%  指标值  POC/VA  数据状态  LIVE             │
└──────────────────────────────────────────────────────────────────────────┘
```

### 5.2 工具栏

顶部工具：

- 品种搜索（可输入 + 下拉；复用 `/api/instruments?query=`）
- 周期：`1m / 3m / 5m / 15m / 30m / 1H / 2H / 4H / 1D`
- 指标管理 drawer
- 画线工具组
- Volume Profile 开关
- 截图
- 全屏
- 复位/滚动到最新

左侧画线工具（桌面）：

- 光标/选择
- 趋势线（segment）
- 水平线（horizontalStraightLine）
- 射线（rayLine）
- 平行通道（priceChannelLine）
- 斐波那契（fibonacciLine）
- 文字（simpleAnnotation）
- 画笔（brush）
- 锁定/删除/清空

### 5.3 页面状态

必须处理：

| 状态 | UI |
|---|---|
| 初始加载 | 图表区域骨架/“正在加载 K 线…” |
| 无品种 | 空态，提示选择品种 |
| 无数据 | 空态 + 错误原因 + 重试 |
| 数据不足 | 正常显示，提示“仅加载到 N 根” |
| 数据过期 | 顶部黄色提示，显示最后更新时间 |
| SSE 断开 | 黄色“实时连接中断，已降级轮询” |
| 图表异常 | ErrorBoundary，显示“图表加载失败”，提供重试；不影响导航 |
| 历史分页失败 | 保留已有 K 线，底部/顶部轻提示，可重试 |

### 5.4 交互规格

- 滚轮缩放；拖拽平移；双击画布恢复默认比例。
- `Shift + 滚轮` 横向滚动。
- 十字光标：所有 pane 同步；主图左上显示 OHLCV；底部显示指标值。
- KLineChart 内置十字光标/轴标签可保留，统一样式。
- 页面失焦/隐藏时不主动重建图表；恢复后继续更新。
- ESC 取消当前画线工具。
- Delete 删除选中画线（仅在 chart 聚焦且选中 overlay 时）。
- 点击触发标记：打开事件信息 popover；点击“查看事件”跳 `/events`（见 9.4）。

### 5.5 移动端

- 顶部工具栏横向可滚动，不换行撑宽页面。
- 画线工具收进底部 drawer。
- 指标管理使用底部 sheet。
- VP 默认宽度缩小；可在 sheet 中开关。
- 图表容器高度：`calc(100dvh - topbar - toolbar - bottom nav)`，最小 360px。
- 390×844 必须 `document.documentElement.scrollWidth === innerWidth`。
- 触摸目标至少 40px。

## 6. 代码结构

### 6.1 新增文件

```text
src/web/pages/ChartPage.tsx
src/web/components/chart/ProChart.tsx
src/web/components/chart/ChartToolbar.tsx
src/web/components/chart/SymbolSearch.tsx
src/web/components/chart/IndicatorManager.tsx
src/web/components/chart/DrawingToolbar.tsx
src/web/components/chart/ChartEventPopover.tsx
src/web/components/chart/ChartStatusBar.tsx
src/web/components/chart/VolumeProfileSettings.tsx
src/web/components/chart/ErrorBoundary.tsx
src/web/lib/chart/types.ts
src/web/lib/chart/dataLoader.ts
src/web/lib/chart/indicatorRegistry.ts
src/web/lib/chart/indicatorSettings.ts
src/web/lib/chart/volumeProfile.ts
src/web/lib/chart/volumeProfileOverlay.ts
src/web/lib/chart/drawings.ts
src/web/lib/chart/persistence.ts
src/web/lib/chart/chartTheme.ts
src/web/styles/chart.css
```

### 6.2 修改文件

```text
package.json                         + klinecharts@10.1.0
src/web/App.tsx                      + /chart route + nav
src/web/pages/DashboardPage.tsx      + 专业图表入口
src/web/api.ts                       + candlesPage / candlesStream URL helper
src/server/api/routes.ts             + before 分页 + candles/stream
src/server/store.ts                 + getCandlesBefore
src/server/market/service.ts         + chart pair 引用计数/订阅合并
src/server/market/provider.ts        + AppMarket 可选方法声明/InstrumentInfo 字段
src/shared/indicators/               + 从 server/indicators 抽纯公式
src/server/indicators.ts             re-export
src/web/main.tsx                     import chart.css（或由 ChartPage 引入）
README.md / docs/API.md / CHANGELOG 文档更新
```

### 6.3 暂时不修改

- `src/web/components/MarketChart.tsx`（总览/试跑继续 ECharts）
- `src/web/components/ChartIndicatorPanel.tsx`（旧面板）
- `src/web/pages/SettingsPage.tsx`（图表配置不进全局 settings）
- 任何 Discord/PushPlus/规则/投递逻辑

## 7. KLineChart 生命周期规范

### 7.1 只初始化一次

`ProChart` 必须把 chart 实例保存在 `useRef`；不能每次 props 变化重建 chart。

```tsx
const containerRef = useRef<HTMLDivElement>(null);
const chartRef = useRef<Chart | null>(null);
const dataLoaderRef = useRef<ChartDataLoader | null>(null);

useEffect(() => {
  const chart = init(containerRef.current!, {
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
    styles: chartTheme,
    layout: {
      barSpaceLimit: { min: 3, max: 32 },
      pane: { minHeight: 90 },
      yAxis: { position: 'right' },
    },
  });
  chartRef.current = chart;
  dataLoaderRef.current = new ChartDataLoader(chart, { ... });
  chart.setDataLoader(dataLoaderRef.current.loader);
  // indicator registry must be registered before init or at module load
  const ro = new ResizeObserver(() => chart.resize());
  ro.observe(containerRef.current!);
  return () => {
    ro.disconnect();
    dataLoaderRef.current?.destroy();
    dispose(containerRef.current!);
    chartRef.current = null;
  };
}, []);
```

### 7.2 切换 symbol/timeframe

```ts
useEffect(() => {
  const chart = chartRef.current;
  if (!chart) return;
  chart.setSymbol({
    ticker: symbol,
    pricePrecision,
    volumePrecision,
  });
  chart.setPeriod(toKLinePeriod(timeframe));
}, [symbol, timeframe, pricePrecision, volumePrecision]);
```

- KLineChart 会自动触发 `unsubscribeBar` 和新的 `getBars({type:'init'})`。
- 切换时必须让旧 SSE 请求被 abort/close；不能把旧品种数据追到新图。
- 对 `setSymbol`/`setPeriod` 的连续快速切换做 debounce 250ms 或 generation id 校验。

### 7.3 指标/画线更新

- 参数/显示变化：`overrideIndicator` 或 `removeIndicator` + `createIndicator`；不重建 chart。
- 画线工具：`createOverlay`；删除：`removeOverlay`；恢复：读取持久化后 `createOverlay`。
- 触发标记：单独 groupId，不随用户“清空画线”删除。
- VP overlay：只创建一次；数据刷新用内部版本号/`overrideOverlay`；不重建 chart。

### 7.4 清理

组件卸载时必须：

1. 关闭 SSE / 停止轮询；
2. abort 进行中的分页请求；
3. `unsubscribeAction`；
4. 断开 ResizeObserver；
5. `dispose(container)`；
6. 清空 loader 的 callback。

## 8. 数据层实现

### 8.1 KLineData 映射

```ts
export function toKLineData(c: Candle): KLineData {
  return {
    timestamp: c.openTime,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volCcyQuote,
    turnover: c.volCcyQuote,
  };
}
```

约束：

- 必须 `Number.isFinite` 校验；无效 K 线丢弃，不能把 `NaN` 传入 KLineChart。
- 按 timestamp 升序；相同 timestamp 去重，保留 confirm=true 优先。
- 最多前端 5,000 根；超过停止 `forward` 并提示。
- `forming` bar 的 timestamp 与已收盘最后一根可能相同；KLineChart 的 `subscribeBar` 会覆盖。

### 8.2 `GET /api/candles`

扩展当前接口，保留现有调用兼容。

请求：

```http
GET /api/candles?instId=BTC-USDT-SWAP&timeframe=5m&limit=500
GET /api/candles?instId=BTC-USDT-SWAP&timeframe=5m&limit=500&before=1763000000000
```

字段：

| 参数 | 类型 | 必填 | 约束 |
|---|---|---|---|
| instId | string | 是 | `^[A-Z0-9-]{3,40}$` |
| timeframe | Timeframe | 是 | `TIMEFRAMES` 白名单 |
| limit | int | 否 | 20–1,000，默认 500（旧调用默认仍兼容 200） |
| before | int | 否 | 毫秒时间戳；只返回 `< before` 的已收盘 K 线 |

响应：

```json
{
  "instId": "BTC-USDT-SWAP",
  "timeframe": "5m",
  "candles": [
    {
      "instId": "BTC-USDT-SWAP",
      "timeframe": "5m",
      "openTime": 1763000000000,
      "open": 68000,
      "high": 68100,
      "low": 67900,
      "close": 68050,
      "volume": 123456,
      "vol": 12,
      "volCcy": 12,
      "volCcyQuote": 123456,
      "confirm": true
    }
  ],
  "page": {
    "hasMore": true,
    "oldest": 1763000000000,
    "newest": 1763003000000
  }
}
```

实现要求：

1. `before` 不存在：返回最新一页。
   - 以 SQLite 中最新已收盘 K 线为主，最多 `limit` 根；
   - 如果最新在内存行情状态中有 forming，追加；不能覆盖已收盘。
   - 如果 DB 几乎为空，调用 `market.fetchHistory` 回填最近范围。
2. `before` 存在：只返回已收盘且 `openTime < before` 的 K 线，不含 forming。
3. SQL 按 `open_ts DESC LIMIT` 查询后反转成升序。
4. 去重按 `openTime`；同一 timestamp 不能重复。
5. `page.hasMore`：本次返回数量等于 limit 且存在更早数据；否则 false。
6. 任何错误返回 502；不要返回空数组伪装成功。
7. 限制 `limit` 上限；不允许负数/NaN。
8. 现有总览/试跑仍可调用旧参数；不要改变 `candles` 数组为对象。

### 8.3 `Store.getCandlesBefore`

新增：

```ts
getCandlesBefore(
  instId: string,
  timeframe: Timeframe,
  before: number,
  limit: number,
): Candle[]
```

SQL：

```sql
SELECT * FROM candles
WHERE inst_id=? AND timeframe=? AND confirm=1 AND open_ts < ?
ORDER BY open_ts DESC
LIMIT ?
```

返回升序。保留现有 `getCandles`。

### 8.4 图表 pair 订阅（关键）

当前 `MarketService.ensurePairs(pairs)` 会 **替换** `this.desired`。SSE 直接调用它会把规则的 pair 退订，这是一个必须避免的回归。

改造要求：

- 增加规则 pair 与图表临时 pair 的合并：
  - `ensurePairs` 保留为规则/引擎的权威来源（或改名为 `setRulePairs` 并提供兼容）。
  - 新增 `addChartPair(pair): Promise<void>`，以引用计数/Set 记录临时图表 pair。
  - 新增 `releaseChartPair(pair): Promise<void>`，引用计数为 0 时移除。
  - 最终订阅 = 规则 pair ∪ 图表 pair。
- `addChartPair` 发现 pair 未初始化时，复用 `initializePair`，等待初始历史。
- `releaseChartPair` 不能删除规则仍在使用的 pair。
- 如果实现引用计数成本高，最低要求：SSE 连接使用一个单独的上限（同时最多 1 个图表 pair），关闭时恢复规则 pair；但不得把规则 pair 退订。
- 增加单元测试：规则 pair 存在时 addChartPair/releaseChartPair，规则 pair 仍保持订阅。

### 8.5 `GET /api/candles/stream`

SSE 契约：

```http
GET /api/candles/stream?instId=BTC-USDT-SWAP&timeframe=5m
Accept: text/event-stream
```

事件：

```text
event: candle
data: {"candle":{"instId":"BTC-USDT-SWAP","timeframe":"5m","openTime":...,"open":...,"high":...,"low":...,"close":...,"volume":...,"volCcyQuote":...,"confirm":false}}

event: heartbeat
data: {"now":1763000000000}
```

实现：

1. 校验 instId/timeframe。
2. 调用 `market.addChartPair`，确保 pair 已被行情服务订阅。
3. 连接后立即发送当前 `getCandlesIncludingForming(..., 1)[0]` 或最新 closed。
4. 监听 `market.on('tick')` 和 `market.on('closed')`；只发送匹配 instId/timeframe 的 candle。
5. 250ms 节流；同一 timestamp 只发最新状态。
6. 每 15 秒发送 heartbeat；客户端断开/服务关闭时移除监听并 `releaseChartPair`。
7. 不发送凭证、错误堆栈或内部对象；错误只发 `event: error` + 安全文案。
8. 设置 `Content-Type: text/event-stream`、`Cache-Control: no-cache`、`Connection: keep-alive`。
9. 连接异常时客户端自动重连；服务端不保留历史队列。

### 8.6 前端 DataLoader

```ts
export class ChartDataLoader {
  private generation = 0;
  private controller: AbortController | null = null;
  private pollTimer: number | null = null;
  private eventSource: EventSource | null = null;

  constructor(private chart: Chart, private deps: ChartDataDeps) {}

  get loader(): DataLoader {
    return {
      getBars: (params) => { void this.getBars(params); },
      subscribeBar: (params) => { this.subscribeBar(params); },
      unsubscribeBar: () => { this.stopRealtime(); },
    };
  }

  private async getBars({ type, timestamp, callback }: DataLoaderGetBarsParams) {
    const generation = ++this.generation;
    this.controller?.abort();
    this.controller = new AbortController();
    try {
      const page = await api.candlesPage({
        instId: this.deps.symbol,
        timeframe: this.deps.timeframe,
        limit: 500,
        before: type === 'forward' ? timestamp ?? undefined : undefined,
      });
      if (generation !== this.generation) return;
      const bars = normalizeBars(page.candles);
      callback(bars, { forward: page.page.hasMore, backward: false });
    } catch (error) {
      if (generation !== this.generation) return;
      callback([], { forward: false, backward: false });
      this.deps.onError(error);
    }
  }

  private subscribeBar({ symbol, period }: DataLoaderSubscribeBarParams) {
    this.stopRealtime();
    // EventSource -> subscribeBar callback; fallback 2s poll after 3 errors
  }

  destroy() {
    this.stopRealtime();
    this.controller?.abort();
  }
}
```

要求：

- `getBars` 的 callback 必须异步返回；不要在同一个事件循环同步返回 `more.forward=true`，否则可能造成 loading loop。
- 并发切换 symbol/timeframe 时只接受最新 generation。
- `forward` 使用 leftmost timestamp；`backward` 不支持，返回 false。
- `subscribeBar` 只推一条 `KLineData`；同 timestamp 覆盖，新 timestamp 追加。
- 切换品种/周期时先关闭旧 EventSource/轮询，再开新连接。
- SSE 连续失败 3 次后降级为 `setInterval` 2 秒请求 `/api/candles?limit=2`；恢复后不再重连旧源或同时双发。


### 8.7 品种精度与合约价值

`KLineChart.setSymbol()` 需要价格/成交量精度，否则 BTC 之外的品种会出现价格轴/读数错误。

要求：

- 扩展 `InstrumentInfo`（`src/server/market/provider.ts`）并确保 `/api/instruments` 返回：
  - `tickSz`（价格最小变动）
  - `lotSz`（数量最小变动）
  - `ctVal` / `ctValCcy`（SWAP 合约面值；为 v1.1 清算名义金额预留）
- 前端精度推导：
  - `pricePrecision = decimalPlaces(tickSz)`，最大 10；
  - `volumePrecision = decimalPlaces(lotSz)`，最大 8；
  - 缺失/非法时从最近 K 线价格字符串/小数位推断，再回退 `2` / `0`。
- `setSymbol({ ticker, pricePrecision, volumePrecision })` 必须使用推导值。
- 品种搜索结果展示 `instId`、`instType`；选择后更新 URL 和图表。
- 单测覆盖 `tickSz=0.0001`、`tickSz=1`、缺失字段、科学计数法/非法值。

## 9. 指标系统

### 9.1 公式共享

把纯公式从 `src/server/indicators.ts` 抽到 `src/shared/indicators/`：

```text
src/shared/indicators/index.ts
src/shared/indicators/bollinger.ts
src/shared/indicators/kdj.ts
src/shared/indicators/rsi.ts
src/shared/indicators/macd.ts
src/shared/indicators/moving.ts
```

`src/server/indicators.ts` re-export，规则引擎保持导入路径不变。

测试要求：

- 使用同一组 fixtures，比较 KLineChart custom calc 输出和共享函数输出。
- 浮点误差 ≤ `1e-8`。
- 空数组、长度不足、零波动、零成交量都有测试。

### 9.2 注册规范

在模块加载时注册，不能每次组件 mount 重复注册：

```ts
let registered = false;
export function registerChartIndicators() {
  if (registered) return;
  registered = true;
  registerIndicator(MS_BOLL);
  registerIndicator(MS_VOL);
  registerIndicator(MS_KDJ);
  registerIndicator(MS_RSI);
  registerIndicator(MS_MACD);
  registerIndicator(MS_MA);
}
```

指标名称统一加 `MS_` 前缀，避免与 KLineChart 内置名称冲突。

### 9.3 P0 指标定义

| id | KLineChart name | pane | 默认参数 | 说明 |
|---|---|---|---|---|
| boll | `MS_BOLL` | candle_pane | 20, 2 | 上/中/下三线 |
| vol | `MS_VOL` | 独立 pane | 20 | 成交额柱 + MA |
| kdj | `MS_KDJ` | 独立 pane | 9, 3, 3 | K/D/J + 20/80 |
| rsi | `MS_RSI` | 独立 pane | 14 | 单线 + 30/70 |
| macd | `MS_MACD` | 独立 pane | 12, 26, 9 | DIF/DEA/Histogram + 0 |
| ma | `MS_MA` | candle_pane | 5,10,20,60 | 多条均线 |

`MS_VOL` 使用 `series: 'volume'`；其余价格指标使用 `series: 'price'`。

KLineChart 内置 figure 类型没有独立 `bar` 图元；成交量柱/MACD histogram 使用 custom indicator 的 `draw` 回调，或 `getFigureClass('rect')` 逐个绘制，不能退化成折线。所有指标必须在 `calc` 中使用共享公式，不能直接用 KLineChart 内置算法替代规则相关指标。

### 9.4 指标管理器

- 点击“指标”打开抽屉/底部 sheet。
- 分组：趋势/动量/波动率/成交量。
- 已启用指标列表：显示名称、参数、pane 顺序。
- 操作：添加、删除、参数编辑、上移/下移、显示/隐藏。
- 添加指标后立刻 `createIndicator`；参数变化 `overrideIndicator`；删除 `removeIndicator`。
- 最多 4 个指标 pane（不含成交量），超出时禁用“添加”并提示。
- 默认配置保持现有行为：BOLL 开、VOL 开，KDJ/RSI/MACD 关；新增 MA 默认关。

### 9.5 设置持久化

新 key：

```text
market-sentinel.chart-workspace.v1
```

结构：

```ts
type ChartWorkspaceState = {
  version: 1;
  indicators: IndicatorInstance[];
  volumeProfile: VolumeProfileSettings;
  drawings: Record<string, SerializedOverlay[]>;
  lastSymbol?: string;
  lastTimeframe?: Timeframe;
};
```

迁移：

- 读取旧 `market-sentinel.chart-indicators.v1`；
- 映射现有 boll/volume/kdj/rsi/macd 的 enabled/params 到新结构；
- 迁移失败不能阻塞图表，使用默认值；
- 写入前做边界清洗；localStorage 不可用/超额时静默降级并 toast 一次。

## 10. Volume Profile 实现

### 10.1 产品定义

- 默认开启，显示当前可见范围的价格—成交额分布。
- 位置：主图右侧，最大宽度为主图宽度的 18%。
- 分箱：默认 80；允许 40/60/80/100。
- 总量；可选上涨/下跌拆分（P0 可只做总量）。
- POC：成交量最大的价格桶，高亮。
- Value Area：从 POC 向两侧扩展到总量 70% 的范围，显示 VAH/VAL。
- 图例：`POC 68,420 · VA 67,900–69,100`。
- 关闭时 overlay 移除；重新开启复用同一个 overlay 实例。

### 10.2 算法

```ts
export interface VolumeProfileBar {
  low: number;
  high: number;
  /** Quote-currency turnover; use KLineData.turnover when mapping chart data. */
  turnover: number;
}

export interface VolumeProfileBin {
  low: number;
  high: number;
  volume: number;
}

export interface VolumeProfileResult {
  bins: VolumeProfileBin[];
  maxVolume: number;
  poc: number;
  valueLow: number;
  valueHigh: number;
  totalVolume: number;
}

export function computeVolumeProfile(
  bars: VolumeProfileBar[],
  binCount = 80,
): VolumeProfileResult {
  if (!bars.length) return emptyProfile();
  const min = Math.min(...bars.map((bar) => bar.low));
  const max = Math.max(...bars.map((bar) => bar.high));
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return emptyProfile();
  }
  const step = (max - min) / binCount;
  const bins: VolumeProfileBin[] = Array.from({ length: binCount }, (_, i) => ({
    low: min + i * step,
    high: min + (i + 1) * step,
    volume: 0,
  }));
  for (const bar of bars) {
    if (!Number.isFinite(bar.turnover) || bar.turnover <= 0) continue;
    const lo = clamp(Math.floor((bar.low - min) / step), 0, binCount - 1);
    const hi = clamp(Math.floor((bar.high - min) / step), 0, binCount - 1);
    const span = Math.max(1, hi - lo + 1);
    const per = bar.turnover / span;
    for (let i = lo; i <= hi; i++) bins[i].volume += per;
  }
  // POC
  let pocIndex = 0;
  for (let i = 1; i < bins.length; i++) {
    if (bins[i].volume > bins[pocIndex].volume) pocIndex = i;
  }
  // Value Area: from POC expand the larger neighbor until 70% of total.
  // ...
  return { bins, maxVolume, poc, valueLow, valueHigh, totalVolume };
}
```

**重要数据映射：** KLineChart `getDataList()` 返回的是 `KLineData`，不是本项目的 `Candle`；它没有 `volCcyQuote` 字段。overlay 中必须先映射：

```ts
const bars = chart
  .getDataList()
  .slice(range.from, range.to + 1)
  .map((bar) => ({
    low: bar.low,
    high: bar.high,
    turnover: bar.turnover ?? bar.volume ?? 0,
  }));
const profile = computeVolumeProfile(bars, settings.bins);
```

边界：

- 空数组返回空；
- `max <= min` 返回空/单桶；
- 所有成交量 0 时 maxVolume=0，不画柱，只显示“无成交量”；
- 不允许 NaN/Infinity；
- 分箱数限制 20–200（UI 只给 40/60/80/100）。

### 10.3 渲染

使用 KLineChart custom overlay `ms_volume_profile`：

```ts
registerOverlay({
  name: 'ms_volume_profile',
  totalStep: 1,
  lock: true,
  createPointFigures: ({ chart, overlay }) => {
    const range = chart.getVisibleRange();
    const bars = chart
      .getDataList()
      .slice(range.from, range.to + 1)
      .map((bar) => ({ low: bar.low, high: bar.high, turnover: bar.turnover ?? bar.volume ?? 0 }));
    const profile = computeVolumeProfile(bars, settings.bins);
    const size = chart.getSize();
    // 右侧起画，宽度按 value/maxVolume 归一化
    // y 使用 chart.convertToPixel({ value: bin.mid }, { paneId: 'candle_pane' })
    return [
      ...profile.bins.map((bin) => ({
        type: 'rect',
        attrs: { x: right - width, y, width, height: Math.max(1, barHeight - 1) },
        styles: { color: 'rgba(49,215,194,.24)' },
        ignoreEvent: true,
      })),
      { type: 'line', attrs: { coordinates: pocLine }, styles: { color: '#efb45d' } },
      { type: 'text', attrs: { x: ..., y: ..., text: 'POC' }, styles: { ... } },
    ];
  },
});
```

实现要求：

- overlay 固定 `candle_pane`，锁定，不可拖动/删除。
- 使用 `chart.getVisibleRange()` 取当前范围；只算可视区。
- 右侧留出价格轴空间；用 `chart.getSize()`/overlay bounding 确定右边界。
- 每根柱子 `ignoreEvent: true`，不能阻塞十字光标。
- POC/VAH/VAL 用细线 + 小标签；文字不要遮挡 K 线。
- overlay 参数变化（bins/POC/VA）通过 `overrideOverlay` 更新；数据更新只需内部快照版本。
- 缩放/平移后 500ms 内重绘完成。
- 如果 custom overlay 的 `createPointFigures` 在缩放时不自动重绘，增加 `onVisibleRangeChange` 监听，调用 `overrideOverlay` 触发重绘；这是阶段 0 必须验证的点。
- 兜底方案：右侧独立 canvas 同步价格轴；接口保持 `VolumeProfileRenderer` 不变。

### 10.4 图例与交互

- 主图顶部增加 `POC/VAH/VAL` DOM 图例，使用 `data-testid="volume-profile-legend"`。
- 设置 sheet：开关、分箱、总量模式、显示 POC/VA、颜色。
- 不实现 hover tooltip（P1）；避免 overlay 阻塞。

## 11. 画线

### 11.1 工具

使用 KLineChart 内置 overlay：

| 工具 | overlay name |
|---|---|
| 趋势线 | `segment` |
| 水平线 | `horizontalStraightLine` |
| 射线 | `rayLine` |
| 通道 | `priceChannelLine` |
| 斐波那契 | `fibonacciLine` |
| 文字 | `simpleAnnotation` |
| 画笔 | `brush` |

### 11.2 行为

- 工具栏选中后调用 `chart.createOverlay({ name, paneId: 'candle_pane' })`。
- ESC/再次点击工具取消当前绘制。
- 右键删除；工具栏“清空画线”二次确认。
- 锁定开关：调用 `overrideOverlay` 设置 `lock`。
- 画线 overlay groupId 统一 `user-drawings`，规则标记 groupId `rule-events`。
- 切换 symbol/timeframe 时保存当前画线，加载新 key；如果 localStorage 中没有，则空白。

### 11.3 持久化

```ts
type SerializedOverlay = {
  name: string;
  points: Array<{ timestamp?: number; dataIndex?: number; value?: number }>;
  styles?: Record<string, unknown>;
  lock?: boolean;
  visible?: boolean;
};
```

- key：`symbol|timeframe`。
- 最多 200 个 overlay/组合；单序列化 <= 256KB。
- 读取时只保留允许的 overlay name；拒绝未知 name/超长 points。
- 恢复时 `createOverlay` 传入完整 points；避免进入交互绘制模式。
- 错误/旧数据静默回退，不阻塞图表。

## 12. 规则触发标记

### 12.1 数据拉取

- 使用现有 `GET /api/events?symbol=...&limit=200&from=...&to=...`。
- 进入图表时拉最近 90 天/最多 200 条；切换 symbol 重新拉取。
- SSE `refresh` 只触发事件列表更新，不重建 chart；更新 marker overlay 时做 diff。
- 只渲染当前可视范围 ± 20 根；超出范围的标记暂存，不创建 overlay。

### 12.2 渲染

- 自定义 overlay `ms_event_marker`，1 个 point，`lock: true`，`groupId: 'rule-events'`。
- 颜色区分 close/intrabar；图标/竖线/标签。
- 点击触发 `onClick`，设置 `selectedEvent`，打开 `ChartEventPopover`。
- Popover 展示：规则名、品种、触发时间、价格、模式、条件摘要、投递状态；按钮“查看事件”跳 `/events`。
- 如果 KLineChart 自定义 overlay 的点击事件不稳定，使用 `onCandleBarClick` 匹配最近坐标；不得让整个 canvas 点击失效。
- 标记不得影响画线/光标；`ignoreEvent` 仅对非交互图形设置。

## 13. 性能、错误与安全

### 13.1 性能预算

- 初始 500 根 + 默认指标 + VP：桌面本地 ≤ 1.5s 可交互。
- 最大 5,000 根；超过停止分页并提示。
- 指标 `calc` 纯函数；不在 tick 中做全量重算。
- 鼠标移动/十字光标不触发 React 全页重渲染；用 DOM readout/ref。
- VP 计算 ≤ 50ms（500 根、80 桶）；超过则降级/减少桶。
- 图表路由 `React.lazy` 加载；不增加总览首屏负担（KLineChart chunk 单独）。
- 不在 localStorage 保存原始 K 线/事件数据。

### 13.2 错误处理

- `ErrorBoundary` 捕获图表渲染错误，显示错误卡片并提供“重新加载图表”。
- SSE/分页错误：toast/状态栏提示，不阻塞已有数据。
- 指标参数非法：回退默认值并在 UI 标记。
- VP 数据无效：隐藏柱、显示“当前范围无有效成交量”。
- 组件卸载 abort 所有请求。

### 13.3 安全

- 所有 symbol/timeframe/limit/before 服务端校验。
- 不执行用户输入的 JS/公式/HTML。
- KLineChart overlay 的 label 使用纯文本，不插入 HTML。
- localStorage 输入只接受白名单字段/数值范围。
- 不允许任意 URL；数据源仍为本站 API。
- 画线数据不含凭证。
- 新增依赖锁定版本；Apache-2.0 许可说明。

## 14. 测试计划

### 14.1 单元测试（新增）

```text
tests/unit/chart-data-loader.test.ts
tests/unit/chart-indicators.test.ts
tests/unit/volume-profile.test.ts
tests/unit/chart-persistence.test.ts
```

覆盖：

- `toKLineData` 数值/排序/去重/NaN。
- `getBars` init/forward 参数、generation 并发、hasMore。
- 指标 parity：BOLL/KDJ/RSI/MACD/VOL/MA。
- VP：POC/VA、零成交量、单价格、空数组、桶边界。
- 设置迁移 v1→v2、非法 localStorage、画线序列化。

### 14.2 集成测试（新增）

- `/api/candles`：before 分页、无重复、limit 上限、非法参数、forming。
- `/api/candles/stream`：首帧、tick/closed 推送、heartbeat、断开清理。
- MarketService：规则 pair + chart pair 引用计数，add/release 不影响规则订阅。
- `/api/events` marker 查询。

### 14.3 E2E（新增）

`tests/e2e/chart.spec.ts`：

1. 导航到 `/chart`，默认加载，OHLC 读数可见，无 console error。
2. 切换 timeframe/ symbol，URL 更新，图表重载。
3. 加载更多：拖到左侧，历史请求触发，无重复标记。
4. 添加 RSI/MACD，修改参数，pane 可见；刷新保留。
5. 画趋势线/水平线，刷新恢复；清空画线。
6. VP 开关，POC/VA 图例；缩放后仍存在。
7. 触发标记（fixture 注入事件）打开 popover。
8. 390px 移动端无横向溢出，工具栏可操作。

必须保持现有 9 个 E2E 全部通过。

### 14.4 主要 `data-testid`

开发和 E2E 必须使用稳定 test id，不依赖 canvas 像素：

| test id | 元素 |
|---|---|
| `chart-workspace` | 页面根容器 |
| `chart-container` | KLineChart 容器 |
| `chart-ohlc-readout` | OHLCV 读数 |
| `chart-symbol-trigger` | 品种选择按钮 |
| `chart-symbol-search` | 品种搜索输入 |
| `chart-timeframe` | 周期按钮组 |
| `chart-indicators-button` | 指标管理入口 |
| `chart-indicator-<id>` | 指标管理项 |
| `chart-indicator-add-<id>` | 添加指标按钮 |
| `chart-pane-toggle-<id>` | 指标显示/隐藏 |
| `chart-drawing-button` | 画线工具栏入口 |
| `chart-drawing-<tool>` | 具体画线工具 |
| `chart-volume-profile-toggle` | VP 开关 |
| `chart-volume-profile-legend` | POC/VA 图例 |
| `chart-event-marker` | 事件标记（如果 DOM 可达；否则用 popover 状态） |
| `chart-event-popover` | 事件详情 popover |
| `chart-status` | 数据状态/错误 |
| `chart-load-more` | 分页状态/重试 |
| `chart-screenshot` | 截图按钮 |
| `chart-fullscreen` | 全屏按钮 |

Canvas 内部不可直接断言像素；用 `chart-ohlc-readout`、图例、状态栏和 data 属性辅助 E2E。

### 14.5 性能/视觉


- Playwright 截图：桌面深色、移动、VP 开/关。
- 5000 根 + 5 指标 + VP 的加载/交互 smoke。
- 生产构建 chunk 分析；KLineChart 页面懒加载。

### 14.6 视觉令牌（v1.0 深色）

沿用项目现有色板：

```text
背景          #080d13
面板          #0b131b / #0e1921
边框          #20303c / #223440
主文字        #cbd9e5
次要文字      #5c7081
上涨          #2fd486
下跌          #f0616a
强调          #31d7c2
POC           #efb45d
网格          #17232d
```

- 图表只实现深色主题；浅色主题放 P1。
- KLineChart 的 tooltip/crosshair/axis 样式必须与项目一致，不保留默认白底。
- 指标颜色沿用现有 `chartIndicators.ts` 的色彩定义，新增指标颜色集中在 `chartTheme.ts`。

## 15. v1.1 扩展：价格层级数据（不在本次验收）

v1.0 的 VP overlay 应抽象出以下接口，供后续订单簿/OKX 强平/链上数据使用：

```ts
interface PriceLevelProvider {
  id: string;
  label: string;
  source: 'derived' | 'okx' | 'onchain' | 'third-party';
  getSnapshot(params: {
    symbol: string;
    timeframe: Timeframe;
    from: number;
    to: number;
    priceRange: { min: number; max: number };
  }): PriceLevelSeries | Promise<PriceLevelSeries>;
  subscribe?(
    params: { symbol: string; timeframe: Timeframe },
    onUpdate: (series: PriceLevelSeries) => void,
  ): () => void;
}
```

v1.1 候选：

- OKX order book depth（价格档位挂单量）。
- OKX liquidation-orders 公共 WS（**仅 OKX 强平样本，不是全市场/链上**）。
- 第三方链上清算/热力图 Provider（需确认数据商和授权）。
- Aave/Compound 链上事件索引器（成本最高）。

数据口径必须标注：`OKX 强平` ≠ `链上协议清算` ≠ `估算清算热力图`。v1.0 不展示任何此类数据，避免误导。

## 16. 开发任务分解与顺序

### 阶段 0：Spike（1–2 天，阻断后续）

- [ ] 安装 `klinecharts@10.1.0`，只做一个 `/chart` 原型页。
- [ ] 渲染 500 根真实/模拟 K 线，验证缩放/平移/ResizeObserver。
- [ ] 注册 `MS_BOLL` 自定义指标，与现有公式对比。
- [ ] 注册 `ms_volume_profile` overlay，画出 POC/VA。
- [ ] 验证缩放后 overlay 重绘、`convertToPixel` 对齐、不阻塞十字光标。
- [ ] 记录结论；若 VP overlay 不可行，启动右侧 canvas 兜底方案。

### 阶段 1：后端数据（3–4 天）

- [ ] `Store.getCandlesBefore`。
- [ ] `/api/candles` before/limit/page/forming。
- [ ] `MarketService` chart pair 引用计数。
- [ ] `/api/candles/stream` SSE + 节流 + 清理。
- [ ] 单元/集成测试。

### 阶段 2：图表骨架（3–4 天）

- [ ] `/chart` 路由、导航、URL 状态。
- [ ] KLineChart 初始化/销毁/切换。
- [ ] DataLoader init/forward/SSE/降级。
- [ ] 工具栏/品种搜索/周期。
- [ ] 状态栏/错误态/移动端骨架。

### 阶段 3：指标（3 天）

- [ ] 共享公式抽取。
- [ ] 6 个 custom indicators。
- [ ] IndicatorManager/参数/pane。
- [ ] 设置迁移与持久化。

### 阶段 4：Volume Profile（3 天）

- [ ] 算法 + 测试。
- [ ] overlay + legend。
- [ ] 缩放更新/缓存/开关。

### 阶段 5：画线与标记（3 天）

- [ ] 画线工具栏/持久化。
- [ ] 触发标记/事件 popover。

### 阶段 6：收尾（2–3 天）

- [ ] 移动端、截图、全屏、快捷键。
- [ ] E2E/视觉/性能。
- [ ] 文档/CHANGELOG。
- [ ] 构建/CI/Docker 验证。

总估算：**16–20 个开发日**（不含 v1.1 数据源）。

## 17. 文档与交付物

实现完成后必须更新：

- `README.md`：专业图表页、功能、截图、运行方式。
- `docs/API.md`：`before`、`page`、SSE 契约。
- `CHANGELOG.md`：新增功能。
- `TEST_REPORT.md`：新增测试数量/结果。
- `docs/CHART_WORKSPACE_IMPLEMENTATION_SPEC.md` 本文件：勾选完成项/记录偏差（如有）。
- 新截图：桌面 `/chart`、移动端、VP 开启。
- 构建产物/CI 结果。

## 18. Definition of Done

- [ ] v1.0 验收门槛全部满足（第 3.2 节）。
- [ ] 无新增 console error/page error。
- [ ] 旧总览、试跑、规则、事件、通知、设置全部不回归。
- [ ] 所有新代码通过 typecheck，新增测试全部通过。
- [ ] 113 个单元/集成测试 + 9 个 E2E 全部通过。
- [ ] 生产构建通过，KLineChart 页面 lazy chunk 生效。
- [ ] Docker 镜像重建后 `/chart` 可用，旧数据保留。
- [ ] 文档/截图/变更日志更新。
- [ ] 提交 PR 或按项目流程推送，CI 全绿。

## 19. 参考资料

- KLineChart 官网：<https://klinecharts.com/>
- v10 数据加载：<https://klinecharts.com/en-US/guide/data-integration>
- 自定义指标：<https://klinecharts.com/en-US/guide/indicator>
- 自定义 overlay：<https://klinecharts.com/en-US/guide/overlay>
- Figure / rect：<https://klinecharts.com/en-US/guide/figure>
- `convertToPixel`：<https://klinecharts.com/en-US/api/instance/convertToPixel>
- `getVisibleRange`：<https://klinecharts.com/en-US/api/instance/getVisibleRange>
- KLineChart GitHub / Apache-2.0：<https://github.com/klinecharts/KLineChart>
- 现有图表：`src/web/components/MarketChart.tsx`
- 现有指标：`src/server/indicators.ts`
- 现有图表配置：`src/web/lib/chartIndicators.ts`
- 现有 API：`src/server/api/routes.ts`
- 设计背景：`docs/CHART_WORKSPACE_DESIGN.md`
