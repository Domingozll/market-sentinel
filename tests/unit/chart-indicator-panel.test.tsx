// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ChartIndicatorPanel } from '../../src/web/components/ChartIndicatorPanel';
import {
  DEFAULT_CHART_INDICATORS,
  type ChartIndicatorSettings,
} from '../../src/web/lib/chartIndicators';

function Harness() {
  const [settings, setSettings] = useState<ChartIndicatorSettings>(DEFAULT_CHART_INDICATORS);
  return (
    <>
      <div data-testid="settings-json">{JSON.stringify(settings)}</div>
      <ChartIndicatorPanel settings={settings} onChange={setSettings} />
    </>
  );
}

describe('ChartIndicatorPanel', () => {
  it('opens, enables KDJ, edits parameters and closes with Escape', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId('chart-indicators-button'));
    expect(screen.getByTestId('chart-indicator-panel')).toBeVisible();
    expect(screen.queryByTestId('indicator-kdj-length')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('indicator-toggle-kdj'));
    expect(screen.getByTestId('indicator-kdj-length')).toHaveValue(9);
    fireEvent.change(screen.getByTestId('indicator-kdj-length'), { target: { value: '12' } });
    expect(screen.getByTestId('indicator-kdj-length')).toHaveValue(12);
    expect(JSON.parse(screen.getByTestId('settings-json').textContent ?? '{}').kdj).toMatchObject({
      enabled: true,
      length: 12,
    });
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('chart-indicator-panel')).not.toBeInTheDocument();
  });

  it('edits BOLL and restores defaults', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId('chart-indicators-button'));
    fireEvent.change(screen.getByTestId('indicator-boll-length'), { target: { value: '26' } });
    fireEvent.change(screen.getByTestId('indicator-boll-mult'), { target: { value: '2.5' } });
    expect(screen.getByTestId('indicator-boll-length')).toHaveValue(26);
    expect(screen.getByTestId('indicator-boll-mult')).toHaveValue(2.5);
    await user.click(screen.getByTestId('indicator-toggle-rsi'));
    expect(screen.getByTestId('indicator-rsi-length')).toBeVisible();
    await user.click(screen.getByTestId('indicator-reset'));
    expect(screen.getByTestId('indicator-boll-length')).toHaveValue(20);
    expect(screen.getByTestId('indicator-boll-mult')).toHaveValue(2);
    expect(screen.queryByTestId('indicator-rsi-length')).not.toBeInTheDocument();
  });
});
