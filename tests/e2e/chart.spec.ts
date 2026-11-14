import { test, expect } from '@playwright/test';

test.describe('Professional chart workspace', () => {
  test('loads candles, indicators, drawing and fullscreen', async ({ page, request }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(String(error)));

    // Make the event-marker/list assertion independent when this file runs alone.
    const initialEvents = await (await request.get('/api/events?limit=1')).json();
    if (initialEvents.total === 0) {
      const candleResponse = await request.get('/api/candles?instId=BTC-USDT-SWAP&timeframe=5m&limit=2');
      const candleState = await candleResponse.json();
      const lastClose = candleState.candles.at(-1).close;
      await request.post('/api/rules', {
        data: {
          name: '图表标记测试',
          symbols: ['BTC-USDT-SWAP'],
          triggerMode: 'close',
          cooldownSec: 0,
          enabled: true,
          expression: {
            kind: 'group',
            op: 'AND',
            children: [{
              kind: 'condition',
              id: 'chart-event-close',
              timeframe: '5m',
              left: { series: 'price.close' },
              cmp: 'gte',
              right: { type: 'number', value: lastClose + 2 },
            }],
          },
        },
      });
      await page.waitForTimeout(900);
      await request.post('/__test__/advance');
      await expect.poll(async () => {
        const response = await request.get('/api/events?limit=1');
        return (await response.json()).total;
      }, { timeout: 10_000 }).toBeGreaterThan(0);
    }

    await page.goto('/chart?symbol=BTC-USDT-SWAP&timeframe=5m', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-workspace')).toBeVisible();
    await expect(page.getByTestId('chart-container').locator('canvas').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('chart-ohlc-readout')).not.toContainText('O —', { timeout: 20_000 });
    await expect(page.getByTestId('chart-status')).toContainText('实时连接');
    await expect(page.getByTestId('chart-volume-profile-legend')).toContainText('POC');
    await expect(page.getByTestId('chart-event-list-toggle')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('chart-event-list-toggle').click();
    await expect(page.getByTestId('chart-event-list')).toBeVisible();
    await page.locator('.chart-event-list-row').first().click();
    await expect(page.getByTestId('chart-event-popover')).toBeVisible();
    await expect(page.getByTestId('chart-event-popover')).toContainText('规则触发');
    await page.getByTestId('chart-event-popover').getByLabel('关闭事件信息').click();

    // The SSE fixture advances a closed bar; the chart readout must follow it.
    const advanced = await request.post('/__test__/advance');
    expect(advanced.ok()).toBeTruthy();
    const advancedBar = await advanced.json();
    const expectedClose = Number(advancedBar.bar.close).toFixed(2);
    await expect.poll(
      async () => page.getByTestId('chart-ohlc-readout').innerText(),
      { timeout: 10_000 },
    ).toContain(expectedClose);

    // Add RSI through the indicator manager and check that the pane appears.
    const beforeCanvases = await page.locator('canvas').count();
    await page.getByTestId('chart-indicators-button').click();
    await expect(page.getByTestId('chart-indicator-panel')).toBeVisible();
    await page.getByTestId('chart-indicator-rsi').locator('input[type=checkbox]').check();
    for (const key of ['kdj', 'macd', 'ma']) {
      await page.getByTestId(`chart-indicator-${key}`).locator('input[type=checkbox]').check();
    }
    await expect.poll(() => page.locator('canvas').count()).toBeGreaterThan(beforeCanvases);
    await page.getByTestId('chart-indicator-panel').getByLabel('关闭指标面板').click();

    // Draw a trendline and verify it is persisted for this symbol/timeframe.
    await page.getByTestId('chart-drawing-button').click();
    await expect(page.getByTestId('chart-drawing-bar')).toBeVisible();
    await page.getByTestId('chart-drawing-segment').click();
    const box = await page.getByTestId('chart-container').boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + 280, box!.y + 300);
    await page.waitForTimeout(150);
    await page.mouse.click(box!.x + 760, box!.y + 220);
    await page.waitForTimeout(300);
    const workspace = await page.evaluate(() => localStorage.getItem('market-sentinel.chart-workspace.v1'));
    expect(workspace).toContain('segment');
    expect(workspace).toContain('BTC-USDT-SWAP|5m');

    // Native fullscreen works in Chromium; the data attribute also covers the mobile fallback.
    await page.getByTestId('chart-fullscreen').click();
    await page.waitForTimeout(250);
    await expect(page.getByTestId('chart-workspace')).toHaveAttribute('data-fullscreen', 'true');
    const stage = await page.getByTestId('chart-workspace').boundingBox();
    expect(stage?.x ?? -1).toBe(0);
    expect(stage?.y ?? -1).toBe(0);
    await page.getByTestId('chart-fullscreen').click();
    await expect(page.getByTestId('chart-workspace')).toHaveAttribute('data-fullscreen', 'false');

    // Reload keeps the indicator and drawing configuration.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-indicator-panel')).toHaveCount(0);
    await page.getByTestId('chart-indicators-button').click();
    await expect(page.getByTestId('chart-indicator-rsi').locator('input[type=checkbox]')).toBeChecked();
    await expect(page.getByTestId('chart-indicator-macd').locator('input[type=checkbox]')).toBeChecked();
    expect(await page.evaluate(() => localStorage.getItem('market-sentinel.chart-workspace.v1'))).toContain('segment');

    // Volume Profile can be toggled without losing the chart.
    await page.getByTestId('chart-volume-profile-toggle').click();
    await expect(page.getByTestId('chart-volume-profile-panel')).toBeVisible();
    await page.getByTestId('volume-profile-enabled').uncheck();
    await expect(page.getByTestId('chart-volume-profile-legend')).toHaveCount(0);
    await page.getByTestId('volume-profile-enabled').check();
    await expect(page.getByTestId('chart-volume-profile-legend')).toBeVisible();
    await page.getByTestId('chart-volume-profile-panel').getByLabel('关闭成交量分布设置').click();
    // Symbol search and timeframe are reflected in the URL.
    await page.getByTestId('chart-symbol-search').fill('ETH-USDT-SWAP');
    await page.locator('.chart-symbol-results button').first().click();
    await expect(page).toHaveURL(/symbol=ETH-USDT-SWAP/);
    await expect(page.getByTestId('chart-symbol-current')).toHaveText('ETH-USDT-SWAP');
    await page.getByTestId('chart-timeframe').getByRole('button', { name: '15m', exact: true }).click();
    await expect(page).toHaveURL(/timeframe=15m/);

    expect(errors).toEqual([]);
  });

  test.describe('mobile fullscreen fallback', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });

    test('fills the viewport without horizontal overflow when native fullscreen is unavailable', async ({ page }) => {
      await page.addInitScript(() => {
        Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
          configurable: true,
          value: undefined,
        });
      });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      await page.goto('/chart?symbol=BTC-USDT-SWAP&timeframe=5m', { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('chart-container').locator('canvas').first()).toBeVisible({ timeout: 20_000 });
      const dims = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      expect(dims.scrollWidth).toBeLessThanOrEqual(dims.width + 1);
      await page.getByTestId('chart-indicators-button').click();
      const panel = await page.getByTestId('chart-indicator-panel').boundingBox();
      expect(panel?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((panel?.x ?? 0) + (panel?.width ?? 0)).toBeLessThanOrEqual(390);
      await page.getByTestId('chart-indicator-panel').getByLabel('关闭指标面板').click();
      await page.getByTestId('chart-fullscreen').click();
      await expect(page.getByTestId('chart-workspace')).toHaveAttribute('data-fullscreen', 'true');
      const box = await page.getByTestId('chart-workspace').boundingBox();
      expect(box?.x ?? -1).toBe(0);
      expect(box?.y ?? -1).toBe(0);
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(viewport.width - 1);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(viewport.height - 1);
      await page.getByTestId('chart-fullscreen').click();
      await expect(page.getByTestId('chart-workspace')).toHaveAttribute('data-fullscreen', 'false');
      expect(errors).toEqual([]);
    });
  });
});
