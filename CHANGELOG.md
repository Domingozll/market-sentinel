# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Configurable market chart indicators: independently toggle BOLL, volume, KDJ, RSI and MACD, adjust their parameters in the chart panel, and persist the selection in the browser.
- Chart legend chips now toggle indicators directly, with parameter labels such as `KDJ(15,3,3)`.
- Responsive mobile and tablet layout: bottom navigation, two-column metrics, compact rule cards, event summary cards, full-width event drawer, bottom-sheet indicator settings and mobile-friendly editor actions.
- Professional KLineChart workspace at `/chart`: 500-bar initial history, cursor pagination, SSE last-bar updates, multi-pane indicators (BOLL/VOL/KDJ/RSI/MACD/MA), drawing tools, rule event markers, Volume Profile (POC/Value Area), local persistence, screenshot and fullscreen.
- Fullscreen support on desktop and mobile, with a CSS viewport fallback when the browser disallows element-level Fullscreen API.
- K-line pagination/SSE APIs and chart-only market subscriptions that are merged with rule subscriptions instead of replacing them.
- Longer candle retention for 1H–1D charts and an external-volume 20k-bar performance benchmark (`npm run chart:perf`).
- WeChat PushPlus notification channel: selectable Discord/PushPlus channel, masked token storage, optional topic, test message, event-channel persistence and retry routing.

### Fixed

- Mobile event rows now preserve the trigger price, and the event drawer close button has an intentional icon-button style instead of browser-default chrome.
- The dashboard chart no longer refetches on every SSE tick, which could cancel requests and leave the chart stuck on “loading” when the candles endpoint was slow.
- Failed background chart refreshes keep the last successful candles instead of clearing the chart.

### Planned

- Multiple Discord webhooks and per-rule routing
- Rule version history and diffs
- Additional notification channels
- More exchange adapters

## [1.0.0] - 2026-11-09

### Added

- Local-first OKX spot/USDT perpetual market monitor using public REST + WebSocket.
- Indicators: Bollinger Bands, KDJ, RSI (Wilder), MACD, volume, average volume and volume ratio.
- Visual AND/OR nested rule builder with 12-condition and 3-level limits.
- Deterministic edge-triggered engine with close confirmation, optional intrabar mode, cooldowns and idempotent event keys.
- Data freshness, gap detection, REST reconciliation, reconnect resync and baseline rebuild.
- SQLite persistence with WAL, event snapshots, delivery outbox and daily retention.
- Discord Embed notifications, masked webhook storage, retries, 429 handling and manual resend.
- React dashboard, rule list/editor, events, settings, ECharts candlesticks, SSE refresh and historical trial.
- Docker image and Compose deployment bound to `127.0.0.1:8787`, non-root app process and persistent data volume.
- Unit, integration, browser E2E and accelerated multi-day engine tests.
- MIT license, contribution/security/conduct policies and CI workflow.

### Security

- Replaced `@fastify/static` with a constrained static file handler.
- Upgraded ECharts to 6.1.0 and development tooling; dependency audit reports zero known vulnerabilities at release time.
- Added CSP and other security headers; webhook URLs are redacted from logs and API responses.
- Static handler rejects dotfiles and traversal outside the built web root.

### Fixed

- New delivery attempts no longer use the exchange clock as a scheduling source.
- Market pair status now recalculates after WebSocket reconnect.
- Docker build includes `public/` assets (favicon).
- Data directory permissions and container runtime user are restricted.
- Default cooldown from settings is applied to new rules.
- Close-bar evaluation waits past the data freshness grace period before evaluating multi-timeframe rules.

[Unreleased]: https://github.com/Domingozll/market-sentinel/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Domingozll/market-sentinel/releases/tag/v1.0.0
