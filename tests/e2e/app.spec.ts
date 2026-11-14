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

  test.afterAll(async () => {
    expect(consoleErrors, `browser errors: ${consoleErrors.join('\n')}`).toEqual([]);
  });
});
