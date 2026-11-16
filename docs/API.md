# API 参考

Market Sentinel 的 HTTP API 与 Web UI 使用同一套 Fastify 路由。默认只监听 `127.0.0.1`，没有账号/Token 认证。可通过 Docker Compose 的 `BIND_HOST=0.0.0.0` 显式开放到可信局域网，但请勿直接暴露到公网。

- Base URL：`http://127.0.0.1:8787`（局域网访问时为 `http://<host-lan-ip>:8787`）
- 请求/响应：`application/json; charset=utf-8`
- 时间：毫秒 Unix 时间戳
- 错误结构：

```json
{
  "error": "规则校验失败",
  "details": ["规则名称需为 2–40 个字符"]
}
```

`details` 仅在部分校验错误中存在。5xx 不返回内部堆栈。

## 健康与状态

### `GET /api/health`

用于 Docker 健康检查和外部探活。返回 200 只代表进程可用，不代表 OKX 一定连通。

```json
{
  "status": "ok",
  "version": "1.0.0",
  "startedAt": 1794212369750,
  "now": 1794212435396,
  "exchangeNow": 1794212435407,
  "wsState": "idle",
  "wsConnected": false,
  "discordConfigured": false,
  "notificationChannel": "discord",
  "notificationsConfigured": false
}
```

### `GET /api/status`

当前运行状态、OKX 连接状态、通知渠道配置状态、版本等。

### `GET /api/dashboard`

总览聚合：主动规则数、今日事件、投递成功率、行情延迟、最近事件和行情 pair 状态。

### `GET /api/diagnostics`

```json
{
  "app": { "ok": true, "wsConnected": true, "wsState": "connected" },
  "marketPairs": [
    {
      "instId": "BTC-USDT-SWAP",
      "timeframe": "5m",
      "state": "healthy",
      "lastReceivedAt": 1794212063924,
      "bars": 299
    }
  ],
  "deliveryQueue": { "pending": 0, "dead": 0, "sent": 0, "skipped": 0 },
  "dataCounts": { "events": 0, "candles": 300, "databaseBytes": 143360 },
  "recentErrors": []
}
```

## 规则

规则表达式最多 12 个叶子条件、3 层嵌套。

### 规则对象示例

```json
{
  "name": "5m 下轨触及",
  "symbols": ["BTC-USDT-SWAP"],
  "triggerMode": "close",
  "cooldownSec": 300,
  "enabled": true,
  "skipUsNonTradingDays": false,
  "note": "",
  "expression": {
    "kind": "group",
    "op": "AND",
    "children": [
      {
        "kind": "condition",
        "id": "touch-lower",
        "timeframe": "5m",
        "left": { "series": "price.low" },
        "cmp": "lte",
        "right": {
          "type": "series",
          "series": "bb.lower",
          "params": { "length": 20, "mult": 2 }
        }
      }
    ]
  }
}
```

字段：

| 字段 | 说明 |
|---|---|
| `name` | 2–40 字符 |
| `symbols` | OKX `instId`，最多 10 个 |
| `triggerMode` | `close`（默认）或 `intrabar` |
| `cooldownSec` | 0–86400 |
| `enabled` | 是否启用 |
| `skipUsNonTradingDays` | 可选，默认 `false`；为 `true` 时不因美股周末/节假日产生新信号 |
| `note` | 可选备注，最多 200 字 |
| `expression` | 条件或条件组；固定数值支持负数和小数 |

`skipUsNonTradingDays` 使用 `America/New_York` 日历，覆盖周末、NYSE/Nasdaq 常规全休市日和已记录的历史临时休市；早收盘日仍算交易日。过滤只抑制新事件，规则状态仍持续更新，因此不会在恢复交易时补发休市期间积累的旧信号。

固定数值阈值必须是有限数字，允许负数和小数，例如 `-1.25`、`0.5`；服务端不会把负值视为非法值。`ratio` 等指标极端的负阈值可能返回单位范围的软警告，但不阻止保存。

条件组：

```json
{
  "kind": "group",
  "op": "OR",
  "children": [
    { "kind": "condition", "...": "..." },
    { "kind": "group", "op": "AND", "children": [] }
  ]
}
```

比较符：`gt`、`gte`、`lt`、`lte`。数值引用：

```json
{ "type": "number", "value": 90 }
{ "type": "series", "series": "kdj.j", "params": { "length": 9, "kSmooth": 3, "dSmooth": 3 } }
```

### `GET /api/rules`

返回 `{ rules: RuleView[] }`，包含聚合状态、每个品种的状态、上次触发等。

### `GET /api/rules/:id`

单个规则详情。

### `POST /api/rules`

创建规则，成功返回 `201`。

```bash
curl -X POST http://127.0.0.1:8787/api/rules \
  -H 'Content-Type: application/json' \
  --data @rule.json
```

```json
{
  "rule": { "id": "8318da02-84ac-42f1-b29b-becc0a1518f5", "ruleStatus": "warming" },
  "warnings": []
}
```

### `PUT /api/rules/:id`

更新规则并重建基线。

### `PATCH /api/rules/:id/enabled`

```json
{ "enabled": false }
```

### `DELETE /api/rules/:id`

归档规则；历史事件不删除。

### `POST /api/rules/:id/duplicate`

创建一份禁用状态的副本。

### `POST /api/replays/:id/position-calc`

按回放信号点计算单笔或批量复利仓位结果。使用已保存回放的 `signalTimeframe` K 线，从每个信号 K 线收盘后开始模拟，不会使用图表周期数据替代。

```json
{
  "config": {
    "direction": "long",
    "capital": 1000,
    "leverage": 5,
    "feeRatePct": 0.05,
    "slippagePct": 0.02,
    "target": { "mode": "percent", "percent": 2 },
    "stop": { "mode": "indicator", "series": "bb.lower" }
  },
  "triggerIndexes": [0, 3, 5]
}
```

- `target`/`stop` 的 `mode`：`none | price | percent | indicator`；`stop` 额外支持 `roi`。`indicator` 可取信号周期上的任意价格类指标（价格/Bollinger 等），服务端按默认参数在触发 K 线计算，不依赖图表周期。
- `price` 为绝对价格；`percent` 为相对开仓价的价格百分比；`roi` 为保证金净收益率（亏损达到当前投入保证金的 `roiPercent`% 时止损，服务端会按手续费和滑点反推价格）；`indicator` 的 `series` 必须是价格类指标，并取该信号条件快照里的值。
- 默认单边手续费 0.05%、单边滑点 0.02%；手续费和滑点均参与净收益和盈亏比计算。
- 批量按信号时间排序复利；始终保持单仓位：若下一选中信号在当前持仓退出前出现，该信号进入 `skipped`（`reason=overlap`），不强制平仓、不延后补开；权益归零后的信号同样进入 `skipped`。每条交易返回 `symbol/direction/leverage/marginMode/entryAt/exitAt/durationMs/entryPrice/exitPrice/quantity/notional/initialMargin/maintenanceMargin/fundingFee/openFee/closeFee/fees/grossPnl/netPnl/roiPct/pnlOnNotionalPct/riskReward/liquidationPrice/equityBefore/equityAfter`；维持保证金和资金费返回 `null` 表示未建模。
- 同一根 K 线同时触发止盈止损按止损优先；跳空按开盘价；未设置止盈止损时按区间最后收盘价；强平按逐仓保证金上限截断；未计资金费率、维持保证金和手续费等级差异。

计算成功返回 `{ calculation, calculationId, cached }`。相同 `replayId + triggerIndexes + config` 会直接返回已保存结果，`cached=true`。计算前会分批补齐信号周期 K 线并严格校验完整性；仍缺数据返回 422，不会用缺口数据继续模拟。配置/信号序号不合法返回 400，回放/记录不存在返回 404。

### `GET /api/replays/:id/position-calculations`

返回该回放最近保存的仓位计算摘要列表（时间、方向/杠杆、本金、信号数、交易数、期末权益、总收益）。

### `GET /api/position-calculations/:id`

返回完整仓位计算记录，包括保存的配置、选中信号、交易明细和汇总。前端“仓位历史”用它恢复查看，不重新计算。

### `POST /api/rules/validate`

只校验，不保存。

```json
{ "ok": true, "summary": "当 5m 最低价 ≤ 布林带下轨(20, 2) 时", "warnings": [] }
```

### `POST /api/rules/preview`

按当前数据给出一组条件判断，不写事件。

```json
{
  "summary": "...",
  "warnings": [],
  "results": [
    {
      "symbol": "BTC-USDT-SWAP",
      "ok": true,
      "evaluation": { "truth": false, "conditions": [] }
    }
  ]
}
```

### `POST /api/rules/trial`

对未保存的规则草稿做历史试跑，不发送通知、不写入正式事件。

```json
{
  "rule": { "...": "同创建格式" },
  "symbol": "BTC-USDT-SWAP",
  "windowDays": 7,
  "chartTimeframe": "15m"
}
```

`windowDays` 1–30；1m 规则最多 7 天。`chartTimeframe` 可选（默认规则最短周期），支持 `TIMEFRAMES` 中的 24 个周期。返回 `triggerCount`、`perDay`、`triggers`、`triggersTruncated`、`candles`、`indicators`、`data` 和 `warning`。

### `POST /api/rules/:id/trial`

对已保存规则执行临时历史回放（不保存记录）。回放使用数据库中的当前规则版本；不发送通知、不写入事件。

```json
{
  "symbol": "BTC-USDT-SWAP",
  "windowDays": 7,
  "chartTimeframe": "15m"
}
```

`chartTimeframe` 可选。行情优先读取本地 `candles`，缺失区间增量补齐；`timeframe` 是图表周期，`signalTimeframe` 是规则实际评估周期。试跑/回放 API 允许 1m/3m 规则使用更长窗口（最多 30 天），会按批量历史分页和本地缓存处理。

成功返回：

```json
{
  "triggerCount": 24,
  "perDay": 3.43,
  "windowDays": 7,
  "symbol": "BTC-USDT-SWAP",
  "timeframe": "15m",
  "signalTimeframe": "5m",
  "data": {
    "source": "local+remote",
    "localBars": 2216,
    "fetchedBars": 200,
    "coverage": 1,
    "gaps": 0,
    "from": 1793600000000,
    "to": 1794211800000
  },
  "triggersTruncated": false,
  "triggers": [
    {
      "triggerAt": 1794211800000,
      "barOpenTime": 1794211500000,
      "barCloseTime": 1794211800000,
      "price": 73891,
      "triggerMode": "close",
      "conditions": [],
      "truth": true,
      "alreadyMatched": false,
      "markerType": "trigger"
    }
  ],
  "candles": [],
  "indicators": { "upper": [], "middle": [], "lower": [] },
  "warning": "仅统计规则触发次数，不计算盈亏，不代表策略有效性。"
}
```

`candles` 覆盖完整回放窗口（图表周期），前端用 `#序号` 与 `triggers` 顺序对应。单次最多保留 500 条触发快照，`triggersTruncated` 表示超出上限。

`data.source` 为 `local`、`local+remote` 或 `remote`；`gaps` 表示首尾未覆盖的 K 线数量。内部缺口拒绝运行并返回 422；首尾历史不足允许在连续区间运行并返回覆盖率。历史数据不足返回 422，规则不存在返回 404。

### `POST /api/rules/:id/replays`

运行并保存一条回放记录。请求与 `/api/rules/:id/trial` 相同：

```json
{
  "symbol": "BTC-USDT-SWAP",
  "windowDays": 7,
  "chartTimeframe": "15m"
}
```

成功返回 `201`：

```json
{
  "replay": {
    "id": "…",
    "ruleId": "…",
    "ruleName": "5m 下轨触及",
    "ruleVersion": 3,
    "symbol": "BTC-USDT-SWAP",
    "windowDays": 7,
    "chartTimeframe": "15m",
    "signalTimeframe": "5m",
    "triggerCount": 24,
    "dataSource": "local",
    "fetchedBars": 0,
    "coverage": 1,
    "createdAt": 1794211800000,
    "result": { "...": "同 TrialResult" }
  }
}
```

记录保存在本机 SQLite，包含完整 `TrialResult` 快照；前端进入回放页时优先读取最近记录，不再自动运行。

自定义日期/每日时段可以传 `period`。同步接口支持小范围，但 Web UI 对自定义范围使用下面的异步接口：

```json
{
  "symbol": "BTC-USDT-SWAP",
  "chartTimeframe": "15m",
  "period": {
    "startDate": "2026-11-01",
    "endDate": "2026-11-16",
    "timezone": "Asia/Shanghai",
    "allDay": false,
    "dailyStart": "09:30",
    "dailyEnd": "16:00"
  }
}
```

- `startDate` / `endDate` 为所选时区的闭区间自然日；`timezone` 为 IANA 时区。
- `allDay=true` 时忽略 `dailyStart`/`dailyEnd`；否则每日时段按同一时区筛选，支持跨午夜（如 `22:00`–`06:00`）。
- 自定义范围最多 366 天，单个周期估算最多 120,000 根；超出返回 422。
- 自定义范围要求历史 K 线完整；仅允许当前最后一根因交易所延迟暂缺。内部缺口/历史不足返回 422。

### `POST /api/rules/:id/replays/async`

按自定义时段创建后台回放任务，立即返回 `202`：

```json
{
  "job": {
    "id": "…",
    "ruleId": "…",
    "status": "queued",
    "phase": "排队中",
    "estimatedSeconds": 48,
    "error": null,
    "replayId": null,
    "createdAt": 1794211800000,
    "startedAt": null,
    "finishedAt": null
  }
}
```

任务会按 OKX 公共历史接口每页 100 根、客户端 130ms 限流分批补全，并写入本地 SQLite；完成后自动保存与同步接口相同结构的回放记录。`estimatedSeconds` 是保守预估，实际耗时取决于本地缓存命中量、网络和补数大小。

### `GET /api/replay-jobs/:id`

返回 `{ job }`；`status` 为 `queued | processing | completed | failed`。完成后 `replayId` 指向已保存回放，失败时 `error` 为原因。服务重启会把未完成任务标记为 `failed`。

### `GET /api/rules/:id/replay-jobs/active`

返回该规则当前仍在排队/处理的最新任务 `{ job: ReplayJobView | null }`；前端刷新回放页时用它恢复进度提示。

### `GET /api/rules/:id/replays`

查询参数 `limit`（1–100，默认 20）。返回 `{ replays: ReplaySummary[] }`，不含完整结果。

### `GET /api/replays/:id`

返回 `{ replay: ReplayRecord }`，包含保存时的完整结果、规则版本和数据来源。

### `GET /api/replays/:id/chart-candles`

按图表周期加载已保存回放窗口的 K 线视图，不重新评估规则、不修改回放记录。

```text
GET /api/replays/:id/chart-candles?timeframe=15m
```

返回：

```json
{
  "replayId": "…",
  "symbol": "BTC-USDT-SWAP",
  "timeframe": "15m",
  "candles": [],
  "data": {
    "source": "local",
    "localBars": 900,
    "fetchedBars": 0,
    "coverage": 1,
    "gaps": 0
  }
}
```

图表周期必须属于 `TIMEFRAMES`；行情同样走本地优先和增量补齐。自定义回放会按保存的 `period.from`/`period.to` 加载同一日期区间。前端在 K 线工具栏内切换周期时调用此接口，仅改变视图；需要保存新周期结果时再调用 `/replays`。

## 事件

### `GET /api/events`

查询参数：

| 参数 | 说明 |
|---|---|
| `limit` | 1–200，默认 50 |
| `offset` | 默认 0 |
| `status` | `pending` / `dead` / `sent` / `skipped` |
| `ruleId` | 规则 ID |
| `symbol` | OKX instId，自动转大写 |
| `from` / `to` | 毫秒时间戳 |

返回：

```json
{
  "events": [
    {
      "id": "…",
      "ruleId": "…",
      "ruleName": "5m 下轨触及",
      "symbol": "BTC-USDT-SWAP",
      "triggerAt": 1794211800000,
      "price": 73891,
      "conditions": [],
      "delivery": {
        "status": "sent",
        "channel": "discord",
        "attempts": 1,
        "externalMessageId": "…"
      }
    }
  ],
  "total": 1
}
```

### `GET /api/events/:id`

返回事件快照、规则版本、条件、投递信息。`delivery.channel` 为 `discord` 或 `pushplus`；`delivery.status = sent` 对 PushPlus 表示请求已被 PushPlus 受理，最终微信送达以流水号/微信为准。

### `POST /api/events/:id/retry`

在事件保存的渠道已配置时，将 `dead` / `skipped` / `pending` 投递重置为待发送并唤醒 worker。Discord 事件只会重试 Discord，PushPlus 事件只会重试 PushPlus。

```json
{ "event": { "delivery": { "status": "pending" } } }
```

## 行情

### `GET /api/candles`

```text
/api/candles?instId=BTC-USDT-SWAP&timeframe=5m&limit=500
/api/candles?instId=BTC-USDT-SWAP&timeframe=1Mutc&limit=500
/api/candles?instId=BTC-USDT-SWAP&timeframe=5m&limit=500
/api/candles?instId=BTC-USDT-SWAP&timeframe=1Mutc&limit=500&before=1763000000000
```

- `timeframe` 支持 OKX 全部周期：`1m/3m/5m/15m/30m/1H/2H/4H/6H/12H/1D/2D/3D/1W/1M/3M`，以及 `6Hutc/12Hutc/1Dutc/2Dutc/3Dutc/1Wutc/1Mutc/3Mutc`。
- `limit` 20–1,000，默认 200；专业图表使用 500。
- 不传 `before`：返回最新一页，合并 SQLite 已收盘 K 线和当前未收盘 K 线。
- 传 `before`：只返回 `openTime < before` 的已收盘 K 线，用于向左分页。
- 返回 `{ instId, timeframe, candles, page: { hasMore, oldest, newest } }`。
- 按 `openTime` 升序、去重；没有缓存时从 OKX 回填并落库。

### `GET /api/candles/stream`

```text
/api/candles/stream?instId=BTC-USDT-SWAP&timeframe=5m
```

`text/event-stream`，用于专业图表实时最后一根 K 线：

```text
event: candle
data: {"candle":{"instId":"BTC-USDT-SWAP","timeframe":"5m","openTime":...,"confirm":false,...}}

event: heartbeat
data: {"now":...}
```

- 服务端为图表建立临时行情 pair 订阅；关闭时释放，但不退订规则仍在使用的 pair。
- SSE 断开后前端降级为 2 秒轮询 `/api/candles?limit=2`。

### `GET /api/instruments`

```text
/api/instruments?query=BTC
```

从 OKX 获取可交易品种，结果缓存 5 分钟；返回 `tickSz` / `lotSz` 等精度字段，专业图表用于 `setSymbol` 价格/数量精度。

## 设置

### `GET /api/settings`

返回公开设置；Webhook 和 PushPlus Token 只返回掩码。

```json
{
  "settings": {
    "discordConfigured": true,
    "discordWebhookMasked": "https://discord.com/api/webhooks/123456…/…abcd",
    "notificationChannel": "pushplus",
    "notificationsConfigured": true,
    "pushplusConfigured": true,
    "pushplusTokenMasked": "••••••••abcd",
    "pushplusTopic": "",
    "proxyUrl": "http://127.0.0.1:7890",
    "useProxyForDiscord": true,
    "defaultCooldownSec": 300,
    "eventRetentionDays": 90,
    "okxRestBase": "https://openapi.okx.com",
    "okxWsUrl": "wss://ws.okx.com/ws/v5/business",
    "timezone": "Asia/Shanghai"
  }
}
```

### `PUT /api/settings`

所有字段可选：

```json
{
  "notificationChannel": "pushplus",
  "discordWebhookUrl": "https://discord.com/api/webhooks/…",
  "pushplusToken": "32-character-pushplus-token",
  "pushplusTopic": "optional-topic",
  "proxyUrl": "http://127.0.0.1:7890",
  "useProxyForDiscord": true,
  "defaultCooldownSec": 300,
  "eventRetentionDays": 90
}
```

- `notificationChannel` 只能是 `discord` 或 `pushplus`；同一时间只使用一个渠道。
- 传 `discordWebhookUrl: null` 清除 Webhook；传 `pushplusToken: null` 清除 PushPlus Token。
- `pushplusToken` 为 8–128 位字母、数字、下划线或连字符；`pushplusTopic` 最多 64 字符。
- 代理由服务端校验为 `http://` / `https://` URL。
- 修改代理会重建行情连接并重建基线。

### `POST /api/settings/test-okx`

```json
{ "proxyUrl": "" }
```

成功返回 `{ ok: true, latencyMs, serverNow }`；失败返回 502。

### `POST /api/settings/test-discord`

```json
{ "webhookUrl": "https://discord.com/api/webhooks/…" }
```

省略 `webhookUrl` 时使用已保存的 Webhook。返回发送结果，不写事件。

### `POST /api/settings/test-pushplus`

```json
{
  "pushplusToken": "32-character-pushplus-token",
  "pushplusTopic": "optional-topic"
}
```

省略 Token / topic 时使用已保存的设置。成功返回 `{ ok: true, httpStatus, messageId }`；Token 无效返回 400，PushPlus 发送失败返回 502。不会写事件记录，也不会返回 Token。HTTP 200 / `code=200` 仅表示 PushPlus 已受理，最终微信送达以流水号/微信为准。

## SSE

### `GET /api/stream`

`text/event-stream`。连接后先收到 `connected`，之后收到 `refresh`：

```text
event: refresh
data: {"type":"rules","at":1794212435396}

```

事件类型可能为 `connected`、`rules`、`events`、`settings`、`market` 等；客户端按任意刷新信号重新拉取即可。

## 静态资源

非 `/api/*` 路径由内置静态文件服务处理：

- `/` 和未知的无扩展名路径返回 SPA `index.html`。
- `/assets/*` 使用长缓存；缺失资源返回 404。
- 拒绝点文件、目录穿越和 web root 外读取。

## 状态码

| 状态码 | 说明 |
|---|---|
| 200 | 成功 |
| 201 | 创建成功 |
| 400 | 参数/规则/设置校验失败 |
| 404 | 规则、事件或 API 不存在 |
| 409 | 业务冲突（最多规则数、不可重试等） |
| 422 | 历史数据不足或无法完成回放 |
| 502 | OKX / Discord / 试跑上游失败 |
| 500 | 未分类服务端错误 |

## 安全与跨站

- 写请求会检查 `Origin` 与 `Host`；跨站写请求被拒绝。
- 官方前端使用同源请求，不需要额外 Token。
- Webhook / PushPlus Token / 代理凭据不会出现在响应中。
- 不要把 API 直接暴露到公网；如需远程访问，请使用 VPN 或带认证的反向代理。
- 局域网模式（`BIND_HOST=0.0.0.0`）仍然没有认证；任何可达客户端都可以修改设置。
