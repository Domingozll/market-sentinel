# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Rule editor: a separate “save keeping status” action that stays on the editor and preserves whether the rule is enabled or disabled; long rule names truncate cleanly while list action buttons stay on one row.
- Custom historical replay periods: inclusive date ranges plus daily time windows (with timezone, all-day and overnight support), presets/defaults, and an async job pipeline.
- Batched OKX history paging (100 bars/request, 130ms request gate) with local SQLite persistence; async jobs expose phase, conservative ETA and reload recovery. Strict custom ranges reject gaps except a late current candle.
- Position calculator on replay signals: single-point and batch compounding, configurable capital/direction/leverage, price/percent/indicator take-profit and stop-loss, fees, slippage, risk/reward and liquidation estimate. Batch mode keeps one position at a time by force-closing at the next selected signal, preventing simultaneous positions. Results expose exchange-style fields including entry/exit times, duration, notional, initial margin, fee split, ROI and equity changes.
- Chart marker/row selection integration for position calculations, including desktop and mobile layouts.

- Configurable market chart indicators: independently toggle BOLL, volume, KDJ, RSI and MACD, adjust their parameters in the chart panel, and persist the selection in the browser.
- Chart legend chips now toggle indicators directly, with parameter labels such as `KDJ(15,3,3)`.
- Responsive mobile and tablet layout: bottom navigation, two-column metrics, compact rule cards, event summary cards, full-width event drawer, bottom-sheet indicator settings and mobile-friendly editor actions.
- Professional KLineChart workspace at `/chart`: OKX's full 24-period set including UTC variants, 500-bar initial history, cursor pagination, SSE last-bar updates, exchange-style per-pane indicator name/params/current values, editable/hideable/closable indicator legend, multi-pane indicators (BOLL/VOL/KDJ/RSI/MACD/MA), drawing tools, rule event markers, Volume Profile (POC/Value Area) with direct visibility toggle and computation status, local persistence, screenshot and fullscreen.
- Fullscreen support on desktop and mobile, with a CSS viewport fallback when the browser disallows element-level Fullscreen API.
- K-line pagination/SSE APIs and chart-only market subscriptions that are merged with rule subscriptions instead of replacing them.
- Longer candle retention for 1H–1D charts and an external-volume 20k-bar performance benchmark (`npm run chart:perf`).
- WeChat PushPlus notification channel: selectable Discord/PushPlus channel, masked token storage, optional topic, test message, event-channel persistence and retry routing.
- Rule editor fixed thresholds now accept negative and decimal values without resetting intermediate input; added a per-rule US equity non-trading-day filter (weekends + NYSE/Nasdaq full closures) shared by the live engine and historical replay.
- Saved-rule historical replay: a dedicated page using the professional KLineChart workspace (24 chart periods selectable inside the K-line toolbar, editable indicators, Volume Profile, drawings, screenshot and fullscreen), with prominent signal markers and hover details (time, price, mode, conditions), per-trigger condition snapshots and a scrollable trigger list.
- Replay snapshots are persisted in SQLite and reloaded instead of re-running automatically; each explicit run creates a history entry.
- Fixed stale replay cache after rule edits: the page now matches saved snapshots by rule version, runs the new version when only old snapshots exist, and keeps old results selectable in history.
- Local-first replay history: reuse cached candles, incrementally fetch only missing ranges, reject internal gaps, and expose data source/coverage metadata.

### Fixed

- Position config now warns before calculation when a percentage stop lies beyond the estimated liquidation distance and explains that stop percentages are price moves, not margin-loss percentages.
- Risk/reward is now omitted when the configured stop is beyond estimated liquidation; cached records are normalized when read.
- Fixed a 20,000-row local candle range cap that made 1m/30-day replays report false 46% coverage and repeatedly refetch the same missing bars.
- Async replay elapsed clock now derives from the job start timestamp and ticks every second instead of staying at 0.
- Position calculator no longer auto-runs on every keystroke; an explicit “开始计算” button produces results only after parameters are confirmed.
- Long-window replay presets for 1m/3m rules are no longer silently shortened; presets above the convenience limit run through the async batch pipeline, including reload-safe jobs.
- Position stop-loss at the estimated liquidation boundary now honours the stop first. Batch calculations process every selected signal in time order and warn when positions overlap instead of silently returning one trade.
- Position calculator warns when `stop percentage × leverage` can consume the full margin, and when a configured stop lies beyond the estimated liquidation price.
- Position calculations now fetch/verify complete signal-timeframe history before simulating, persist successful calculations, reuse the same replay+points+config cache, and expose history in the replay UI.
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

- Position config now warns before calculation when a percentage stop lies beyond the estimated liquidation distance and explains that stop percentages are price moves, not margin-loss percentages.
- Risk/reward is now omitted when the configured stop is beyond estimated liquidation; cached records are normalized when read.
- Fixed a 20,000-row local candle range cap that made 1m/30-day replays report false 46% coverage and repeatedly refetch the same missing bars.
- Async replay elapsed clock now derives from the job start timestamp and ticks every second instead of staying at 0.
- Position calculator no longer auto-runs on every keystroke; an explicit “开始计算” button produces results only after parameters are confirmed.
- New delivery attempts no longer use the exchange clock as a scheduling source.
- Market pair status now recalculates after WebSocket reconnect.
- Docker build includes `public/` assets (favicon).
- Data directory permissions and container runtime user are restricted.
- Default cooldown from settings is applied to new rules.
- Close-bar evaluation waits past the data freshness grace period before evaluating multi-timeframe rules.

[Unreleased]: https://github.com/Domingozll/market-sentinel/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Domingozll/market-sentinel/releases/tag/v1.0.0
