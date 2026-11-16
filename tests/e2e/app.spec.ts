import { test, expect } from '@playwright/test';

test.describe.serial('Market Sentinel system flow', () => {
  const consoleErrors: string[] = [];
  test.beforeEach(async ({ page }) => {
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(String(error)));
  });

  test('configure Discord, create a rule, trigger it, and inspect the delivery', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '总览' })).toBeVisible();
    await expect(page.locator('.topbar')).toContainText('行情正常');

    // Configure and test a Discord webhook (transport is mocked in the fixture server).
    await page.getByRole('link', { name: /设置/ }).click();
    await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
    const webhook = 'https://discord.com/api/webhooks/123456789012345678/e2e-token-abcdef';
    await page.getByTestId('webhook-input').fill(webhook);
    await page.getByTestId('save-settings').click();
    await expect(page.locator('.masked-value')).toContainText('discord.com');
    await expect(page.locator('.masked-value')).not.toContainText('e2e-token-abcdef');
    await page.getByTestId('test-discord').click();
    await expect(page.locator('.test-feedback.ok')).toContainText('测试消息已发送');

    // Create a lower-band rule from a template.
    await page.getByRole('link', { name: /规则/ }).click();
    await page.locator('.template-card').filter({ hasText: '下轨触及' }).click();
    await expect(page.getByRole('heading', { name: '新建规则' })).toBeVisible();
    await expect(page.getByTestId('rule-name')).toHaveValue('5m 下轨触及');
    await page.getByTestId('save-rule').click();
    await expect(page).toHaveURL(/\/rules$/);
    const row = page.locator('.rule-list-grid').filter({ hasText: '5m 下轨触及' }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText('监控中', { timeout: 10_000 });

    // Push a closed candle that touches the lower band.
    const advance = await request.post('/__test__/advance');
    expect(advance.ok()).toBeTruthy();
    await page.waitForTimeout(1200);

    // The event should be visible and delivered through the mocked Discord transport.
    await page.getByRole('link', { name: /事件/ }).click();
    await expect(page.getByRole('heading', { name: '事件' })).toBeVisible();
    const eventRow = page.locator('.event-row-real').filter({ hasText: '5m 下轨触及' }).first();
    await expect(eventRow).toBeVisible({ timeout: 10_000 });
    await expect(eventRow).toContainText('已送达', { timeout: 10_000 });
    await eventRow.click();
    await expect(page.locator('.drawer')).toHaveClass(/open/);
    await expect(page.locator('.drawer-title')).toContainText('5m 下轨触及');
    await expect(page.locator('.drawer')).toContainText('条件快照');
    await expect(page.locator('.drawer')).toContainText('已送达');

    const stateResponse = await request.get('/__test__/state');
    const state = await stateResponse.json();
    expect(state.sentMessages.length).toBeGreaterThanOrEqual(2);
    expect(state.sentMessages[0].embeds[0].title).toContain('测试消息');
    expect(state.events.total).toBe(1);
    expect(state.events.events[0].delivery.status).toBe('sent');
    expect(state.events.events[0].conditions[0].truth).toBe(true);
  });

  test('validation errors are surfaced without creating a rule', async ({ page }) => {
    await page.goto('/rules/new');
    await expect(page.getByRole('heading', { name: '新建规则' })).toBeVisible();
    await page.getByTestId('rule-name').fill('x');
    await page.getByTestId('save-rule').click();
    await expect(page.locator('.error-banner')).toContainText('规则名称需为 2–40 个字符');
    await expect(page).toHaveURL(/\/rules\/new/);
  });

  test('rules can be paused and resumed from the list', async ({ page }) => {
    await page.goto('/rules');
    const row = page.locator('.rule-list-grid').filter({ hasText: '5m 下轨触及' }).first();
    await expect(row).toBeVisible();
    const toggle = row.getByRole('switch');
    await toggle.click();
    await expect(row).toContainText('已暂停', { timeout: 10_000 });
    await toggle.click();
    await expect(row).not.toContainText('已暂停', { timeout: 10_000 });
    await expect(row).toContainText(/监控中|已满足|预热中/);
  });


  test('rule editor shows live preview and runs a historical trial', async ({ page }) => {
    await page.goto('/rules');
    await page.locator('.rule-main-btn').first().click();
    await expect(page.getByRole('heading', { name: '编辑规则' })).toBeVisible();
    await expect(page.locator('[data-testid="discord-preview"]')).toBeVisible();
    await page.getByRole('button', { name: '试跑' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByTestId('run-trial').click();
    await expect(page.locator('.trial-metrics')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.modal-body canvas')).toBeVisible();
    await expect(page.locator('.modal-body')).toContainText('触发次数');
    await page.locator('.modal-foot').getByRole('button', { name: '关闭' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });


  test('saved rule replay shows historical candles, markers and trigger list', async ({ page }) => {
    let replayRuns = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/replays$/.test(new URL(request.url()).pathname)) replayRuns++;
    });
    await page.goto('/rules', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('rule-history').first().click();
    await expect(page.getByText('历史 K 线与通知位置')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('replay-result')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('replay-chart').locator('canvas').first()).toBeVisible();
    await expect(page.getByTestId('replay-list')).toBeVisible();
    await expect(page.getByTestId('replay-data-info')).toBeVisible();
    const rows = page.getByTestId('replay-row');
    if (await rows.count()) {
      await expect(rows.first()).toContainText('#1');
      await expect(rows.first()).toContainText('收盘确认');
      await rows.first().click();
      await expect(rows.first()).toHaveClass(/selected/);
    } else {
      await expect(page.getByTestId('replay-list')).toContainText('窗口内没有触发');
    }

    // Indicators are the same editable KLineChart workspace used by the chart page.
    await page.getByTestId('replay-chart-indicators').click();
    await expect(page.getByTestId('chart-indicator-panel')).toBeVisible();
    await page.getByRole('button', { name: '关闭指标面板' }).click();

    // Chart period tabs live inside the KLineChart toolbar. Switching only changes
    // the chart view; running/saving is still explicit.
    await expect(page.getByTestId('replay-timeframes')).toBeVisible();
    await expect(page.getByTestId('replay-chart-timeframe')).toHaveCount(0);
    const runsBeforeTimeframe = replayRuns;
    await page.getByTestId('replay-timeframe-15m').click();
    await expect(page.locator('.replay-chart-card .panel-sub')).toContainText('15m', { timeout: 20_000 });
    expect(replayRuns).toBe(runsBeforeTimeframe);
    await page.getByTestId('run-replay').click();
    await expect(page.getByTestId('replay-history').locator('option')).toHaveCount(3, { timeout: 20_000 });
    expect(replayRuns).toBe(runsBeforeTimeframe + 1);

    // Reloading loads the latest saved result instead of running again.
    const runsBeforeReload = replayRuns;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('replay-result')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('replay-timeframe-15m')).toHaveClass(/active/);
    expect(replayRuns).toBe(runsBeforeReload);
    await expect(page.getByTestId('replay-history').locator('option')).toHaveCount(3);
    await expect(page.getByTestId('replay-chart').locator('canvas').first()).toBeVisible();

    // The saved result can be re-run with another window and updates the chart.
    await page.getByTestId('replay-window-30').click();
    await page.getByTestId('run-replay').click();
    await expect(page.locator('.trial-metric').filter({ hasText: '回看时段' })).toContainText('30', { timeout: 20_000 });
    await expect(page.getByTestId('replay-chart').locator('canvas').first()).toBeVisible();
  });

  test('rule edits invalidate the replay cache and run the new version', async ({ page, request }) => {
    const expression = {
      kind: 'group',
      op: 'AND',
      children: [{
        kind: 'condition',
        id: 'cache-v1',
        timeframe: '5m',
        left: { series: 'price.close' },
        cmp: 'gte',
        right: { type: 'number', value: 0 },
      }],
    };
    const created = await request.post('/api/rules', {
      data: {
        name: '缓存版本回放 v1',
        symbols: ['BTC-USDT-SWAP'],
        triggerMode: 'close',
        cooldownSec: 0,
        enabled: true,
        expression,
      },
    });
    expect(created.ok()).toBeTruthy();
    const ruleId = (await created.json()).rule.id as string;
    let replayRuns = 0;
    page.on('request', (req) => {
      if (req.method() === 'POST' && /\/replays$/.test(new URL(req.url()).pathname)) replayRuns++;
    });

    await page.goto('/rules', { waitUntil: 'domcontentloaded' });
    const rowV1 = page.locator('.rule-list-grid').filter({ hasText: '缓存版本回放 v1' }).first();
    await rowV1.getByTestId('rule-history').click();
    await expect(page.getByTestId('replay-result')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('replay-rule-updated')).toHaveCount(0);
    const runsBeforeEdit = replayRuns;

    const updated = await request.put(`/api/rules/${ruleId}`, {
      data: {
        name: '缓存版本回放 v2',
        symbols: ['BTC-USDT-SWAP'],
        triggerMode: 'close',
        cooldownSec: 3600,
        enabled: true,
        expression: {
          ...expression,
          children: [{ ...expression.children[0], id: 'cache-v2', cmp: 'lt', right: { type: 'number', value: 0 } }],
        },
      },
    });
    expect(updated.ok()).toBeTruthy();

    await page.goto('/rules', { waitUntil: 'domcontentloaded' });
    const rowV2 = page.locator('.rule-list-grid').filter({ hasText: '缓存版本回放 v2' }).first();
    await rowV2.getByTestId('rule-history').click();
    await expect(page.getByTestId('replay-result')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('replay-rule-updated')).toBeVisible();
    await expect(page.locator('.replay-history-meta')).toContainText('规则 v2');
    await expect(page.getByTestId('replay-history').locator('option')).toHaveCount(3);
    expect(replayRuns).toBe(runsBeforeEdit + 1);
  });

  test('chart indicators can be enabled, configured, hidden and persisted', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('market-chart')).toBeVisible();
    await expect(page.locator('.chart-legend-chip[data-indicator="boll"]')).toContainText('BOLL(20,2)');
    await expect(page.locator('.chart-legend-chip[data-indicator="volume"]')).toContainText('VOL(20)');

    await page.getByTestId('chart-indicators-button').click();
    await expect(page.getByTestId('chart-indicator-panel')).toBeVisible();
    await page.getByTestId('indicator-toggle-kdj').check();
    await page.getByTestId('indicator-kdj-length').fill('12');
    await page.getByTestId('indicator-toggle-rsi').check();
    await page.getByTestId('indicator-rsi-length').fill('21');

    await expect(page.locator('.chart-legend-chip[data-indicator="kdj"]')).toContainText('KDJ(12,3,3)');
    await expect(page.locator('.chart-legend-chip[data-indicator="rsi"]')).toContainText('RSI(21)');
    await expect(page.getByTestId('market-chart')).toHaveAttribute('data-chart-indicators', 'volume,kdj,rsi');
    await page.getByRole('button', { name: '关闭指标设置' }).click();

    await page.reload();
    await expect(page.locator('.chart-legend-chip[data-indicator="kdj"]')).toContainText('KDJ(12,3,3)');
    await expect(page.locator('.chart-legend-chip[data-indicator="rsi"]')).toContainText('RSI(21)');
    await expect(page.getByTestId('market-chart')).toHaveAttribute('data-chart-indicators', 'volume,kdj,rsi');

    await page.locator('.chart-legend-chip[data-indicator="volume"]').click();
    await expect(page.getByTestId('market-chart')).toHaveAttribute('data-chart-indicators', 'kdj,rsi');
    await page.getByTestId('chart-indicators-button').click();
    await page.getByTestId('indicator-toggle-volume').check();
    await expect(page.getByTestId('market-chart')).toHaveAttribute('data-chart-indicators', 'volume,kdj,rsi');
  });



  test('configures PushPlus and sends a test message through the mocked transport', async ({ page, request }) => {
    await page.goto('/settings', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
    await page.getByTestId('notification-channel-pushplus').click();
    await page.getByTestId('pushplus-token').fill('e2e-pushplus-token-1234');
    await page.getByTestId('pushplus-topic').fill('e2e-group');
    await page.getByTestId('save-settings').click();
    await expect(page.getByTestId('notification-channel-pushplus')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.topbar')).toContainText('微信 PushPlus 已配置');
    const pushplusBlock = page.getByTestId('pushplus-block');
    await expect(pushplusBlock.locator('.masked-value')).toContainText('••••');
    await expect(pushplusBlock.locator('.masked-value')).not.toContainText('e2e-pushplus-token-1234');
    await page.getByTestId('test-pushplus').click();
    await expect(pushplusBlock.locator('.test-feedback.ok')).toContainText('PushPlus 已受理测试消息');
    const stateResponse = await request.get('/__test__/state');
    const state = await stateResponse.json();
    expect(state.pushplusMessages.some((message: any) => String(message.title).includes('测试消息'))).toBe(true);

    await page.goto('/rules/new', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('pushplus-preview')).toBeVisible();
    await expect(page.getByTestId('discord-preview')).toHaveCount(0);
    await page.getByTestId('pushplus-preview-test').click();
    await expect(page.locator('.toast-item')).toContainText('PushPlus 测试消息已受理');
  });

  test.describe('mobile viewport', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });

    test('stacks navigation, editor, event drawer and chart controls without overflow', async ({ page, request }) => {
      page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
      page.on('pageerror', (error) => consoleErrors.push(String(error)));

      const noHorizontalOverflow = async (label: string) => {
        const dims = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        }));
        expect(dims.scrollWidth, `${label} horizontal overflow`).toBeLessThanOrEqual(dims.innerWidth + 1);
      };

      // Make the drawer test independent when only this test is selected.
      const eventCheck = await request.get('/api/events?limit=1');
      const eventState = await eventCheck.json();
      if (eventState.total === 0) {
        const candleResponse = await request.get('/api/candles?instId=BTC-USDT-SWAP&timeframe=5m&limit=2');
        const candleState = await candleResponse.json();
        const lastClose = candleState.candles.at(-1).close;
        await request.post('/api/rules', {
          data: {
            name: '移动端布局演示',
            symbols: ['BTC-USDT-SWAP'],
            triggerMode: 'close',
            cooldownSec: 0,
            enabled: true,
            expression: {
              kind: 'group',
              op: 'AND',
              children: [{
                kind: 'condition',
                id: 'mobile-close',
                timeframe: '5m',
                left: { series: 'price.close' },
                cmp: 'gte',
                right: { type: 'number', value: lastClose + 2 },
              }],
            },
          },
        });
        await page.waitForTimeout(350);
        await request.post('/__test__/advance');
        await page.waitForTimeout(1200);
      }

      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('.mobile-brand')).toBeVisible();
      await expect(page.getByTestId('market-chart')).toBeVisible({ timeout: 20_000 });
      const sidebar = await page.locator('.sidebar').boundingBox();
      expect(sidebar?.y ?? 0).toBeGreaterThan(500);
      await noHorizontalOverflow('dashboard');

      await page.locator('.chart-card').scrollIntoViewIfNeeded();
      await page.getByTestId('chart-indicators-button').click();
      const panel = await page.getByTestId('chart-indicator-panel').boundingBox();
      expect(panel?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((panel?.x ?? 0) + (panel?.width ?? 0)).toBeLessThanOrEqual(390);
      expect((panel?.y ?? 0) + (panel?.height ?? 0)).toBeLessThanOrEqual(844);
      await page.getByRole('button', { name: '关闭指标设置' }).click();
      await noHorizontalOverflow('dashboard with chart');

      await page.getByRole('link', { name: /规则/ }).click();
      await expect(page.getByRole('heading', { name: '规则' })).toBeVisible();
      await expect(page.locator('.rule-list-head')).toBeHidden();
      await noHorizontalOverflow('rules');

      await page.getByRole('link', { name: /事件/ }).click();
      await expect(page.getByRole('heading', { name: '事件' })).toBeVisible();
      const eventRow = page.locator('.event-row-real').first();
      await expect(eventRow).toBeVisible();
      await expect(eventRow.locator('.event-real-price')).toBeVisible();
      await eventRow.click();
      await expect(page.locator('.drawer')).toHaveClass(/open/);
      const drawer = await page.locator('.drawer').boundingBox();
      expect(drawer?.width ?? 0).toBeLessThanOrEqual(390);
      await expect(page.locator('.drawer .detail-block').first()).toBeVisible();
      await page.locator('.drawer .close-x').click();
      await noHorizontalOverflow('events and drawer');

      await page.getByRole('link', { name: /设置/ }).click();
      await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
      await noHorizontalOverflow('settings');

      await page.goto('/rules', { waitUntil: 'domcontentloaded' });
      await page.getByTestId('rule-history').first().click();
      await expect(page.getByTestId('replay-result')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('replay-chart')).toBeVisible();
      await noHorizontalOverflow('history replay');

      await page.goto('/rules/new', { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: '新建规则' })).toBeVisible();
      const builder = await page.locator('.builder-card').boundingBox();
      const side = await page.locator('.side-stack').boundingBox();
      expect(side?.y ?? 0).toBeGreaterThan(builder?.y ?? 0);
      await noHorizontalOverflow('rule editor');

      await page.setViewportSize({ width: 768, height: 1024 });
      await page.goto('/rules', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('.mobile-brand')).toBeVisible();
      await expect(page.getByRole('heading', { name: '规则' })).toBeVisible();
      const tabletSidebar = await page.locator('.sidebar').boundingBox();
      expect(tabletSidebar?.y ?? 0).toBeGreaterThan(600);
      await noHorizontalOverflow('tablet rules');

      await page.setViewportSize({ width: 1024, height: 768 });
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('.mobile-brand')).toBeHidden();
      await expect(page.getByTestId('market-chart')).toBeVisible({ timeout: 20_000 });
      await noHorizontalOverflow('desktop breakpoint');
    });
  });

  test('keeps custom period and position calculator usable on mobile', async ({ page }) => {
    const noHorizontalOverflow = async (label: string) => {
      const dims = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(dims.scrollWidth, `${label} horizontal overflow`).toBeLessThanOrEqual(dims.innerWidth + 1);
    };
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/rules', { waitUntil: 'domcontentloaded' });
    const row = page.locator('.rule-list-grid').filter({ hasText: '下轨触及' }).first();
    await row.getByTestId('rule-history').click();
    await expect(page.getByTestId('replay-result')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('replay-window-custom').click();
    await expect(page.getByTestId('replay-custom-period')).toBeVisible();
    await noHorizontalOverflow('mobile custom replay period');

    await page.getByTestId('replay-calc-0').click();
    await expect(page.locator('.modal-card')).toBeVisible();
    await page.locator('.modal-card').getByTestId('position-calculate').click();
    await expect(page.locator('.modal-card').getByTestId('position-calc-summary')).toBeVisible({ timeout: 15_000 });
    await noHorizontalOverflow('mobile position calculator');
    await page.locator('.modal-card .modal-foot button').click();
  });

  test('saves negative decimal thresholds and the US market filter', async ({ page }) => {
    await page.goto('/rules/new', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: '新建规则' })).toBeVisible();
    await page.getByTestId('rule-name').fill('负数阈值与美股过滤');
    await page.getByLabel('条件 1 右侧类型').selectOption('number');
    const threshold = page.getByLabel('条件 1 阈值');
    await threshold.fill('-1.25');
    await expect(threshold).toHaveValue('-1.25');
    await page.getByTestId('skip-us-non-trading-days').check();
    await page.getByTestId('save-rule').click();
    await expect(page).toHaveURL(/\/rules$/);

    const row = page.locator('.rule-list-grid').filter({ hasText: '负数阈值与美股过滤' }).first();
    await expect(row).toContainText('过滤美股非交易日');
    await row.locator('button[title="编辑"]').click();
    await expect(page.getByRole('heading', { name: '编辑规则' })).toBeVisible();
    await expect(page.getByLabel('条件 1 阈值')).toHaveValue('-1.25');
    await expect(page.getByTestId('skip-us-non-trading-days')).toBeChecked();
  });

  test('save keeping status stays on the editor and long names keep actions in one row', async ({ page, request }) => {
    const longName = '长名称规则用于验证按钮不会换行和溢出-ABCDEFGHIJKLMNOP';
    await page.goto('/rules/new', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: '新建规则' })).toBeVisible();
    await page.getByTestId('rule-name').fill(longName);
    await page.getByTestId('rule-enabled').uncheck();
    await page.getByTestId('save-rule-keep-status').click();
    await expect(page).toHaveURL(/\/rules\/[^/]+\/edit$/);
    await expect(page.getByRole('heading', { name: '编辑规则' })).toBeVisible();
    await expect(page.getByTestId('rule-enabled')).not.toBeChecked();

    const ruleId = page.url().match(/\/rules\/([^/]+)\/edit$/)?.[1];
    expect(ruleId).toBeTruthy();
    const fetched = await request.get(`/api/rules/${ruleId}`);
    expect(fetched.ok()).toBeTruthy();
    expect((await fetched.json()).rule.enabled).toBe(false);

    // A second keep-status save on the edit page must not toggle the rule on.
    await page.getByTestId('save-rule-keep-status').click();
    await expect(page).toHaveURL(/\/rules\/[^/]+\/edit$/);
    const fetchedAgain = await request.get(`/api/rules/${ruleId}`);
    expect((await fetchedAgain.json()).rule.enabled).toBe(false);

    // Creating an enabled rule and saving from its edit page must keep it enabled.
    const expression = {
      kind: 'group',
      op: 'AND',
      children: [{
        kind: 'condition',
        id: 'keep-on',
        timeframe: '5m',
        left: { series: 'price.close' },
        cmp: 'gte',
        right: { type: 'number', value: 0 },
      }],
    };
    const created = await request.post('/api/rules', {
      data: { name: '保持启用的规则', symbols: ['BTC-USDT-SWAP'], triggerMode: 'close', cooldownSec: 0, enabled: true, expression },
    });
    expect(created.ok()).toBeTruthy();
    const enabledId = (await created.json()).rule.id as string;
    await page.goto(`/rules/${enabledId}/edit`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('save-rule-keep-status').click();
    await expect(page).toHaveURL(new RegExp(`/rules/${enabledId}/edit$`));
    const enabledFetched = await request.get(`/api/rules/${enabledId}`);
    expect((await enabledFetched.json()).rule.enabled).toBe(true);

    await page.goto('/rules', { waitUntil: 'domcontentloaded' });
    const row = page.locator('.rule-list-grid').filter({ hasText: longName }).first();
    await expect(row).toBeVisible();
    const actions = row.locator('.rule-actions .icon-btn');
    await expect(actions).toHaveCount(4);
    const boxes = await actions.evaluateAll((nodes) => nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { top: Math.round(rect.top), right: Math.round(rect.right) };
    }));
    expect(new Set(boxes.map((box) => box.top)).size).toBe(1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('opens single and batch position calculator for replay signals', async ({ page }) => {
    await page.goto('/rules', { waitUntil: 'domcontentloaded' });
    const row = page.locator('.rule-list-grid').filter({ hasText: '下轨触及' }).first();
    await row.getByTestId('rule-history').click();
    await expect(page.getByTestId('replay-result')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('replay-calc-0')).toBeVisible();

    await page.getByTestId('replay-calc-0').click();
    const modal = page.locator('.modal-card');
    await expect(modal.getByText('仓位计算', { exact: true })).toBeVisible();
    await modal.getByTestId('position-calculate').click();
    await expect(modal.getByTestId('position-calc-summary')).toBeVisible({ timeout: 15_000 });
    await expect(modal.getByTestId('position-calc-single')).toContainText('净盈亏');
    await expect(modal.getByTestId('position-calc-single')).toContainText('开仓时间');
    await expect(modal.getByTestId('position-calc-single')).toContainText('平仓时间');
    await expect(modal.getByTestId('position-calc-single')).toContainText('总手续费');
    await expect(modal.getByTestId('position-calc-single')).toContainText('收益率（保证金）');
    await expect(modal.getByTestId('position-calc-single')).toContainText('估算强平');
    const exits = modal.locator('.position-exit-control');
    await exits.nth(0).locator('select').selectOption('percent');
    await exits.nth(0).locator('input[type="number"]').fill('2');
    await exits.nth(1).locator('select').selectOption('percent');
    await exits.nth(1).locator('input[type="number"]').fill('1');
    await modal.getByTestId('position-calculate').click();
    await expect(modal.getByTestId('position-calc-single')).toContainText('盈亏比');
    await modal.locator('.modal-foot button').click();

    await page.getByTestId('replay-select-0').check();
    await page.getByTestId('replay-select-1').check();
    await page.getByTestId('replay-calc-selected').click();
    await expect(page.locator('.modal-card').getByText(/批量复利计算/)).toBeVisible();
    await page.locator('.modal-card').getByTestId('position-calculate').click();
    await expect(page.locator('.modal-card').getByTestId('position-calc-summary')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.modal-card .position-trade-row')).toHaveCount(2);
  });

  test('runs a custom date range asynchronously with an ETA and loads the result', async ({ page }) => {
    await page.goto('/rules', { waitUntil: 'domcontentloaded' });
    const row = page.locator('.rule-list-grid').filter({ hasText: '下轨触及' }).first();
    await row.getByTestId('rule-history').click();
    await expect(page.getByTestId('replay-result')).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('replay-window-custom').click();
    const end = await page.getByTestId('replay-custom-end').inputValue();
    await page.getByTestId('replay-custom-start').fill(end);
    await expect(page.getByTestId('replay-custom-period')).toBeVisible();
    // Keep the job banner alive long enough to verify the elapsed clock ticks.
    const jobRoute = /\/api\/replay-jobs\//;
    await page.route(jobRoute, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      await route.continue();
    });
    await page.getByTestId('run-replay').click();
    await expect(page.getByTestId('replay-job-progress')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByTestId('replay-job-progress')).toContainText('预计约');
    await page.waitForTimeout(1300);
    await expect(page.getByTestId('replay-job-progress')).not.toContainText('已用 0 秒');
    await page.unroute(jobRoute);
    await expect(page.getByTestId('replay-job-progress')).toBeHidden({ timeout: 30_000 });
    await expect(page.getByTestId('replay-result')).toBeVisible();
    await expect(page.locator('.replay-metric-period')).toContainText(end);
    await expect(page.getByTestId('replay-custom-period')).toBeVisible();
  });

  test('honors a 30-day preset for a 1m rule through an async job', async ({ page, request }) => {
    const created = await request.post('/api/rules', {
      data: {
        name: '1m 长窗口回放',
        symbols: ['BTC-USDT-SWAP'],
        triggerMode: 'close',
        cooldownSec: 0,
        enabled: false,
        expression: {
          kind: 'group',
          op: 'AND',
          children: [{
            kind: 'condition',
            id: 'long-window',
            timeframe: '1m',
            left: { series: 'price.close' },
            cmp: 'gte',
            right: { type: 'number', value: 0 },
          }],
        },
      },
    });
    expect(created.ok()).toBeTruthy();
    const ruleId = (await created.json()).rule.id as string;

    await page.goto('/rules', { waitUntil: 'domcontentloaded' });
    await page.locator('.rule-list-grid').filter({ hasText: '1m 长窗口回放' }).first().getByTestId('rule-history').click();
    await expect(page.getByTestId('replay-result')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('replay-window-30').click();
    await page.getByTestId('run-replay').click();
    await expect(page.getByTestId('replay-job-progress')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByTestId('replay-job-progress')).toBeHidden({ timeout: 30_000 });
    await expect(page.getByTestId('replay-result')).toBeVisible();
    await expect(page.locator('.replay-metric-period')).toContainText('30');
    await expect(page.getByTestId('replay-window-30')).toHaveClass(/btn-primary/);
    await expect(page.getByTestId('replay-result')).not.toContainText('最多试跑 7 天');
    // Keep the created rule visible to the test fixture for subsequent state assertions.
    expect(ruleId).toBeTruthy();
  });

  test.afterAll(async () => {
    expect(consoleErrors, `browser errors: ${consoleErrors.join('\n')}`).toEqual([]);
  });
});
