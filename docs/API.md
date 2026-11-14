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
| `note` | 可选备注，最多 200 字 |
| `expression` | 条件或条件组 |

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

历史试跑，只统计触发次数，不发送 Discord。

```json
{
  "rule": { "...": "同创建格式" },
  "symbol": "BTC-USDT-SWAP",
  "windowDays": 7
}
```

`windowDays` 1–30；1m 规则最多 7 天。返回 `triggerCount`、`perDay`、`triggers`、`candles`、`indicators` 和 `warning`。

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
/api/candles?instId=BTC-USDT-SWAP&timeframe=5m&limit=500&before=1763000000000
```

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
| 502 | OKX / Discord / 试跑上游失败 |
| 500 | 未分类服务端错误 |

## 安全与跨站

- 写请求会检查 `Origin` 与 `Host`；跨站写请求被拒绝。
- 官方前端使用同源请求，不需要额外 Token。
- Webhook / PushPlus Token / 代理凭据不会出现在响应中。
- 不要把 API 直接暴露到公网；如需远程访问，请使用 VPN 或带认证的反向代理。
- 局域网模式（`BIND_HOST=0.0.0.0`）仍然没有认证；任何可达客户端都可以修改设置。
