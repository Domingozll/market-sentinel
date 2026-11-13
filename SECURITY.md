# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 1.x | Yes |

## Reporting a vulnerability

请不要在公开 Issue 中披露可利用细节、Webhook、代理凭据或个人数据。

优先使用 GitHub 的 **Private vulnerability reporting**：

1. 打开仓库的 **Security** 标签。
2. 选择 **Report a vulnerability**（若仓库已启用）。
3. 提供影响、复现步骤、受影响版本和建议修复。

如果私密报告入口不可用，请开一个不含敏感信息的 Issue，说明“需要私密渠道”，维护者会跟进。请勿在 Issue 中粘贴真实 token。

## Threat model

本项目是单用户本地应用：

- 默认只绑定 `127.0.0.1`。
- 可以通过 Compose 的 `BIND_HOST=0.0.0.0` 显式发布到可信局域网；应用没有登录系统，任何能访问该端口的主机都可以修改规则和设置。
- 没有登录系统；不要直接暴露到公网。
- Discord Webhook 和代理凭据存储在本地 SQLite；依赖宿主机账户和磁盘安全。
- OKX 只使用公共行情接口，不保存交易所 API Key。
- API 写操作校验 `Origin`/`Host`，但仍不是多用户权限系统。

不属于本项目安全边界的内容：

- 已取得本机文件读写权限的攻击者；
- 用户自行把端口暴露到公网；
- 用户在 Issue/日志中主动泄露自己的 Webhook；
- 第三方 OKX/Discord 服务自身的问题。

## Deployment hardening

- 默认保持 `127.0.0.1:8787` 绑定。需要局域网访问时，把 `BIND_HOST` 设为 `0.0.0.0` 并仅允许可信网段；不要做公网端口转发。远程访问使用 VPN 或带认证的反向代理。
- 不要把 `.env`、`data/` 提交到 git。
- 定期 `npm audit` 并更新依赖。
- 使用最小权限运行容器；项目入口脚本会在授权数据目录后降权到 `node` 用户。
- 定期备份 `data/`，但备份中也包含 Webhook 凭据。

## Known dependency policy

CI 会运行 `npm audit --omit=dev --audit-level=high`。出现高危运行时依赖时不应发布新版本。

## LAN exposure

`BIND_HOST=0.0.0.0` publishes port 8787 on every host interface. Market Sentinel has no authentication or per-user authorization. Use it only on a trusted LAN, restrict the port with the host firewall where possible, and never port-forward it to the public internet.
