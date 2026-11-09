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
    await page.getByRole('button', { name: '发送测试消息' }).click();
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

  test.afterAll(async () => {
    expect(consoleErrors, `browser errors: ${consoleErrors.join('\n')}`).toEqual([]);
  });
});
