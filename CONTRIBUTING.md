# Contributing to Market Sentinel

感谢你愿意改进行情哨兵。这个项目优先保证三件事：**规则语义可预测、数据异常不误报、变更可验证**。

## Before you start

- 先搜索已有 Issue / PR，避免重复。
- 较大的行为变更（新指标、触发语义、数据库 schema）请先开 Issue 讨论。
- 安全漏洞不要公开提交，见 [SECURITY.md](SECURITY.md)。

## 环境

- Node.js 24+
- npm 10+
- Docker（仅容器相关改动需要）
- Google Chrome（本机 E2E 默认浏览器）

```bash
git clone https://github.com/Domingozll/market-sentinel.git
cd market-sentinel
npm ci
npm run typecheck
npm test
```

> 本项目使用 Node 内置 `node:sqlite`，因此 Node 24 是硬性要求。

## Development

```bash
# 终端 1
npm run dev

# 终端 2
npm run dev:web
```

前端开发服务器默认在 `http://127.0.0.1:5173`，`/api` 会代理到 8787。

## Project boundaries

| 层 | 目录 | 责任 |
|---|---|---|
| 行情 | `src/server/market/` | OKX REST/WS、数据新鲜度、缺口、重连 |
| 指标 | `src/server/indicators.ts` | 纯函数公式，不读数据库 |
| 规则 | `src/server/rules/` | schema、评估器、状态机、摘要 |
| 存储 | `src/server/store.ts` | SQLite schema、事务、幂等键 |
| 通知 | `src/server/alerts/` | payload、outbox、重试 |
| API | `src/server/api/` | 输入校验、HTTP 映射 |
| UI | `src/web/` | React 页面、组件、格式化 |

关键约束：

- 规则试跑与线上判断必须共用 `src/server/rules/evaluator.ts`。
- 不要在指标函数里发起网络请求或写数据库。
- 事件是快照：不要用当前规则内容动态渲染历史事件。
- 任何会改变触发语义的改动，必须同时更新测试、设计文档和 CHANGELOG。

## Adding an indicator

1. 在 `src/shared/types.ts` 增加 series 元数据、参数定义和默认参数。
2. 在 `src/server/indicators.ts` 实现纯函数，并处理 warm-up 的 `null`。
3. 在 `src/server/rules/evaluator.ts` 注册序列计算。
4. 在前端 `RuleBuilder` / 参数控件中展示。
5. 在 `tests/unit/indicators.test.ts` 添加公式断言；在规则测试中覆盖参数校验。
6. 更新 `docs/DESIGN.md` 的指标定义。

## Adding/changing rule semantics

请先明确：

- 触发是边沿还是水平？
- 使用收盘数据还是盘中数据？
- 多周期如何对齐？数据缺失怎么办？
- 重启/重连后是否需要重建基线？
- 旧事件是否应该被改写？

默认原则：**不确定时不要通知**。宁可暂停并重建基线，也不要使用旧数据补发。

## Tests

```bash
npm run typecheck
npm test
npm run test:e2e      # 本机 Chrome
PLAYWRIGHT_CHANNEL=bundled npm run test:e2e   # Playwright 自带 Chromium
```

提交前至少：

- `npm run typecheck`
- `npm test`
- UI/路由/交互变更：`npm run test:e2e`
- 依赖变更：`npm audit`
- Docker 相关：`docker compose build` 并手工 smoke `/api/health`

真实 Discord Webhook 不属于自动化测试；请使用 mock，且在本地手动测试时不要把 token 提交到仓库或粘贴到 Issue。

## Style

- TypeScript strict；尽量保持类型在 `src/shared/types.ts`，避免前后端重复定义。
- 服务端错误对用户友好，不输出凭据；内部错误记录日志。
- UI 面向中文用户，代码标识符和注释可使用英文。
- 时间一律用毫秒时间戳；显示时显式使用 `Asia/Shanghai`。
- 不引入大型依赖除非有明确收益；运行时依赖保持精简。

## Commits / PR

- 建议 Conventional Commits：`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`。
- 一个 PR 聚焦一件事；行为变更附上测试。
- PR 描述包含：动机、行为变化、测试命令、截图（UI）、迁移/兼容性说明。
- 不要提交 `node_modules/`、`dist/`、`data/`、`.env`、测试截图产物。

## License

提交贡献即表示你同意以 [MIT License](LICENSE) 授权你的贡献。
