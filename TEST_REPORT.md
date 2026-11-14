# 行情哨兵 · 测试与部署验收报告

> 日期：2026-11-09  
> 版本：v1.0.0（含 2026-11-09 行情图指标、2026-11-14 移动端与 PushPlus 增量）
> 说明：本报告记录 v1.0.0 在本地 macOS + Docker 验收环境的结果；自动化测试命令可在任意支持 Node 24 的环境复现。  
> 结论：在本文定义的范围内，**全部自动化测试通过，无已知未修复功能缺陷**；Docker 容器已在本机部署并通过健康检查。  
> 注意：测试不能证明软件绝对没有缺陷；“无已知 bug”仅代表已覆盖场景全部通过。

## 1. 测试环境

| 项目 | 版本 / 环境 |
|---|---|
| 操作系统 | macOS 26.0.1 |
| Node.js | v24.22.0 |
| npm | 11.21.1 |
| Docker | 29.6.1 |
| Docker Compose | v5.2.0 |
| 浏览器 | Google Chrome 156.0.8078.80 |
| 测试框架 | Vitest 5.1.0 + Playwright 1.65 |
| 行情源 | OKX 公共 REST + WebSocket（真实网络） |
| Discord / PushPlus | 模拟 HTTP 传输（不向真实频道发送，不使用真实 Token） |

## 2. 结果总览

| 测试层 | 结果 |
|---|---|
| TypeScript 类型检查 | 通过 |
| 单元 + 集成测试 | **20 个测试文件，105 个测试全部通过**（~2s 测试耗时） |
| 浏览器 E2E | **7 个场景全部通过**（~12s） |
| 构建 | 通过（Vite + esbuild；产物约 154 KB 服务端、前端 1.5 MB JS） |
| 依赖安全审计 | `npm audit`、`npm audit --omit=dev` 均为 **0 vulnerabilities** |
| Docker 镜像 | `market-sentinel:1.0.0`，约 277 MB |
| 容器健康 | `healthy` |
| 容器运行用户 | 应用进程 UID/GID 1000 (`node`)，入口仅以 root 执行目录授权后降权 |
| 数据持久化 | 重启 / 重建容器后规则和状态保留；旧 `deliveries` 表自动新增渠道列，历史投递保留为 Discord |
| 真实 OKX 容器验收 | REST 与 WebSocket 连接成功；5m 规则基线完成，状态“监控中” |
| 最终数据状态 | 验收使用独立临时数据；用户本地 data/ 不进入仓库 |

### 部署地址

```text
http://127.0.0.1:8787
```

验收默认只映射到宿主机 loopback；Docker Compose 可通过 `BIND_HOST=0.0.0.0` 显式开放到可信局域网，但这会暴露无认证的本地 UI/API。通知凭据由用户在本机设置页配置，仓库不包含任何真实凭据。

## 3. 自动化测试明细

| 文件 | 测试数 | 覆盖内容 |
|---|---:|---|
| `tests/unit/indicators.test.ts` | 14 | SMA/EMA、布林带总体标准差、KDJ 9/3/3、RSI Wilder、MACD、成交量倍数、比较符 |
| `tests/unit/time.test.ts` | 4 | 交易所周期边界、1D UTC+8 日界、收盘宽限、K 线连续性 |
| `tests/unit/rules.test.ts` | 10 | 规则 schema、参数校验、嵌套、单位警告、摘要、多周期表达式、盘中形成 K 线 |
| `tests/unit/engine.test.ts` | 7 | 边沿触发、基线、冷却、重复推送幂等、盘中路标/收盘确认、重连重建基线 |
| `tests/unit/engine-extra.test.ts` | 4 | 多品种独立状态、重启去重、盘中收盘确认、迟到信号压制 |
| `tests/unit/trial.test.ts` | 6 | 试跑触发计数、冷却、窗口基线、盘中警示、周期窗口限制 |
| `tests/unit/soak.test.ts` | 1 | 864 根未来 5m K 线（3 天）加速回放：事件不丢不重、无异常 |
| `tests/unit/web-format.test.ts` | 6 | 时间/数字/时长格式化、状态映射、自然语言摘要、模板 schema |
| `tests/unit/rule-builder.test.tsx` | 2 | 条件构建器交互、AND/OR、添加/删除、条件数量上限 |
| `tests/unit/chart-indicators.test.ts` | 5 | 图表指标默认值、范围钳制、MACD 关系、图例标签、localStorage 持久化 |
| `tests/unit/chart-indicator-panel.test.tsx` | 2 | 指标面板开关、参数编辑、恢复默认、Escape 关闭 |
| `tests/integration/pushplus.test.ts` | 7 | PushPlus payload、固定端点、成功/429/5xx/业务错误、Token 脱敏、渠道投递全链路 |
| `tests/integration/api.test.ts` | 9 | 规则 CRUD、预览、设置脱敏、CSRF、事件、Discord 投递、数据接口、试跑 |
| `tests/integration/api-extra.test.ts` | 5 | 设置测试端点、永久失败手动重试、事件快照不可变、过滤与 404 |
| `tests/integration/discord.test.ts` | 12 | Embed 内容、mentions 禁用、429/5xx/4xx、超时、敏感信息脱敏、outbox 重试/上限 |
| `tests/integration/okx-rest.test.ts` | 5 | OKX REST 解析、成交量字段、500 重试、错误、历史分页 |
| `tests/integration/okx-ws.test.ts` | 1 | WebSocket 订阅频道、K 线推送解析 |
| `tests/integration/okx-ws-reconnect.test.ts` | 1 | 意外断线后自动重连并重新订阅 |
| `tests/integration/market-service.test.ts` | 1 | REST 初始历史 + WebSocket 订阅 + 健康状态 + 新收盘 K 线入库 |
| `tests/integration/web-static.test.ts` | 3 | 静态资源、SPA fallback、路径穿越/点文件防护、安全头、SSE 推送 |

### E2E 场景（真实浏览器）

1. 设置页保存 Discord Webhook → 发送测试消息 → 模板创建“下轨触及”规则 → 假行情触发 → 事件列表显示“已送达” → 打开事件详情验证条件快照与投递。
2. 空名称规则保存被阻止，出现校验错误，未创建规则。
3. 规则从列表暂停 → 恢复；确保状态从“已暂停”恢复为监控/满足状态。
4. 规则编辑器实时预览 → 打开试跑 Modal → 运行历史回放 → 渲染触发统计和 ECharts K 线图。
5. 行情图指标面板：打开面板 → 启用/配置 KDJ 与 RSI → 关闭并刷新 → 设置持久化 → 点击图例隐藏成交量 → 从面板重新启用。
6. PushPlus：设置页选择微信 PushPlus → 填写 Token/topic → 保存 → 发送测试消息 → 规则编辑器显示 PushPlus 文本预览并发送测试；Token 掩码、当前渠道和 mock 请求均已验证。
7. 移动端布局：390px 下底部导航、图表指标底部面板、规则卡片、事件摘要与全屏抽屉、设置页和规则编辑器均无横向溢出；768px 与 1024px 断点也通过。

E2E 同时检查浏览器 console error 与 page error，最终为 0。

## 4. 业务验收覆盖

### 指标

- 布林带使用 SMA + 总体标准差；带宽、%B、中轨斜率均有独立断言。
- KDJ 使用 9/3/3、K/D 初值 50、横盘 RSV=50、J 可为负/超 100 的公式。
- RSI 使用 Wilder 平滑；全涨=100、全跌=0、横盘=50。
- MACD 柱 = DIF − DEA，明确不乘 2。
- 成交量使用报价货币成交额 `volCcyQuote`，量能倍数在零均量时返回空值。
- 价格数据使用 OHLC；多周期数据不本地重采样。

### 规则与触发

- “J 到 90”“斜率转负”“触及下轨”“AND 组合”均可配置。
- 整条表达式 false→true 只触发一次；持续满足不重复。
- 冷却生效；被冷却压制的边沿不会延迟补发。
- 同一 `规则 × 品种 × K线` 数据库唯一键 + 重启验证，重复推送不会重复发送。
- 多品种状态互相独立，只触发实际满足的品种。
- 多周期组合在一次评估中使用各周期最新收盘 K 线。
- 默认收盘确认；盘中事件带“未确认/已确认”状态。
- 启动、编辑、数据缺口恢复后重建基线，不补发历史触发。
- 数据过期导致规则进入 degraded；不会用旧值发送。
- 超过 2 分钟的迟到收盘信号被抑制，不通知。

### 数据与可靠性

- OKX REST 的 `volCcyQuote`、确认状态、缺失字段解析。
- REST 5xx 重试；4xx 失败；历史 K 线倒序分页并排序去重。
- WebSocket 业务频道订阅 `candle5m` 等；断线重连后重新订阅。
- MarketService：加载初始历史 → WS 健康 → 新收盘 K 线入库/发出事件。
- 数据缺口会触发 REST 补洞，补不齐则暂停规则。
- 启动失败/无网络时 UI 显示连接状态，不崩溃。

### Discord / PushPlus 通知

- 消息 Embed 结构、条件快照、事件 ID、免责声明。
- `allowed_mentions.parse = []`，防止 @everyone。
- 429 `Retry-After`、5xx 重试、4xx 永久失败、最大尝试次数。
- pending → sending → sent / dead 状态流转。
- 永久失败可在事件详情手动重试。
- Webhook / PushPlus Token 脱敏，不出现在 API/诊断/错误日志。
- 成功投递后 E2E 验证事件状态、消息内容和投递记录。

### 安全与系统功能

- 默认仅通过本机 loopback 访问；跨站 Origin 的写请求被拒绝。显式 `BIND_HOST=0.0.0.0` 时 API 仍无认证，仅供可信局域网。
- Webhook 必须使用 Discord 官方 HTTPS 域名。
- 静态资源：
  - 无目录列表；
  - 拒绝点文件；
  - 路径穿越无法读取 web root 之外文件；
  - 缺失资源返回 404，不做 HTML fallback；
  - CSP、X-Content-Type-Options、X-Frame-Options、Referrer-Policy 等安全头。
- SSE 初始事件和刷新事件。
- 依赖审计 0 漏洞。
- Docker：健康检查、非 root 应用进程、数据目录 0700、bind mount 数据持久化。

## 5. 容器验收记录

1. `docker compose build` 成功。
2. `docker compose up -d` 成功，容器状态 `healthy`。
3. `GET /api/health` 返回 200。
4. 从容器内发起 OKX 真实行情连接：
   - REST 初始 K 线 299 根；
   - WebSocket 状态 `connected`；
   - 5m 交易对状态 `healthy`；
   - 规则基线完成，显示“监控中”。
5. `docker compose restart` / 用新镜像重建容器后：
   - 规则保留；
   - 应用重新建立基线；
   - 健康检查恢复 `healthy`。
6. 最终清空验收规则和事件，重新创建容器，当前为干净首次启动状态。
7. `favicon.svg`、静态页面、API 均返回 200。
8. 容器应用进程 UID 1000 (`node`)；入口脚本在授权数据目录后降权。

## 6. 测试中发现并修复的问题

| # | 问题 | 修复 |
|---|---|---|
| 1 | 新投递的 `next_attempt_at` 使用行情时钟，行情时钟超前时 Discord 发送被延迟 | 新投递改为立即到期，worker 按真实时钟调度 |
| 2 | WebSocket 连上后部分规则状态仍显示 `disconnected` | 重连/首次连接后按当前 K 线重新计算 pair 健康状态 |
| 3 | `@fastify/static` 当前版本有高危路径绕过通告 | 移除依赖，替换为受约束、经安全测试的本地静态文件路由 |
| 4 | ECharts < 6.1 有已知 XSS 通告 | 升级至 ECharts 6.1，图表回归通过 |
| 5 | Vitest/esbuild 开发依赖存在审计问题 | 升级 Vitest 5.1、esbuild 0.28，审计归零 |
| 6 | Docker 镜像漏复制 `public/favicon.svg` | Dockerfile 显式复制 `public/`，容器内 favicon 200 |
| 7 | Docker 数据目录权限不统一 | entrypoint 设置 umask、0700 目录、chown 给 node 用户 |
| 8 | 默认冷却设置未应用新建规则 | 编辑器首次加载时应用设置页默认值 |
| 9 | 条件卡头部与事件时间小字布局异常 | 补齐样式与专用构建回归 |
| 10 | 多周期同一收盘边界可能使用上一根高周期数据 | 将收盘等待设为 2.2s，覆盖 2s 数据宽限后再评估 |
| 11 | 图表对每次 SSE 刷新都重新请求 candles，慢接口导致请求互相取消、一直显示加载中 | 改为品种/周期变化时加载、15s 定时刷新，并使用稳定的 hasData 依赖 |
| 12 | 图表加载失败后的“重试”按钮设置相同 timeframe，不能触发重新请求 | 增加 chartRefreshKey，错误重试和手动刷新都会重新加载；后台失败保留旧图 |

## 7. 已知限制 / 未覆盖项

1. **没有向真实 Discord 频道或微信 PushPlus 发送消息**：测试使用受控 HTTP transport 验证完整 outbox 与通知交互，避免使用/泄露真实凭据。用户需要在 UI 中配置自己的 Webhook / PushPlus Token 并点击“发送测试消息”。
2. **没有进行 24 小时壁钟连续运行**：进行了 864 根 5m K 线（3 天）的加速回放、WebSocket 断线重连测试和真实容器短时运行；长时间网络/系统休眠行为仍需在真实使用中观察。
3. 盘中模式使用未收盘 K 线，历史盘中路径无法还原；试跑按收盘口径计算。
4. 规则试跑不是盈亏回测，不评估策略有效性。
5. 同一时间只使用一个通知渠道（Discord 或 PushPlus）；不自动下单；不支持序列条件（A 后 N 根内 B）。
6. 容器在 Docker Desktop/macOS 上验证；Linux 上 bind mount 所有者可能被 entrypoint 改为 UID 1000，需部署者知悉。
7. 前端包约 1.5 MB（gzip ~500 KB），Vite 有 chunk size 警告，不影响功能。
8. 未做专业渗透测试；已做的安全测试、依赖审计和默认 loopback 约束见上。

## 8. 复现命令

```bash
cd market-sentinel
npm ci
npm run typecheck
npm test
npm run test:e2e
npm audit
npm run build
docker compose build
docker compose up -d
curl http://127.0.0.1:8787/api/health
```

当前交付状态：

```bash
docker compose ps
# market-sentinel ... Up ... (healthy) 127.0.0.1:8787->8787/tcp
```

## 9. 用户最终验收步骤

1. 打开 <http://127.0.0.1:8787>。
2. 设置 → 选择 Discord 或微信 PushPlus → 填写对应凭据 → 保存 → 发送测试消息并确认收到。
3. 规则 → 使用模板或自定义条件 → 保存并启用。
4. 在总览确认行情连接、规则状态与数据时间。
5. 可在规则编辑器使用“试跑”观察最近 7/30 天触发频率。
6. 事件页检查触发快照、通知渠道与投递状态。

如测试消息失败，请检查对应渠道的域名访问和代理配置；应用不会回显完整 Webhook URL 或 PushPlus Token。

## 10. 结论

所有已定义的业务规则、指标公式、多周期/盘中触发、幂等与冷却、数据异常保护、Discord / PushPlus 投递、API、安全静态服务、SSE、可配置行情图、移动端/平板布局、浏览器交互和 Docker 部署场景均已通过自动化验证。当前交付在已测试范围内无已知未修复缺陷。
