import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/server/store';
import { RuleEngine } from '../../src/server/rules/engine';
import { parseRuleInput } from '../../src/server/rules/schema';
import { bollingerBands } from '../../src/server/indicators';
import { FakeMarket, makeCandles, wait } from '../helpers/fake-market';
import type { RuleDraft } from '../../src/shared/types';

const symbol = 'BTC-USDT-SWAP';
const tfMs = 300_000;
const warmupBars = 320;
const futureBars = 864; // three days of 5m bars
const baseEnd = Date.parse('2026-11-09T16:00:00+08:00');
const finalEnd = baseEnd + futureBars * tfMs;

function ruleDraft(): RuleDraft {
  return {
    name: '三日加速回放',
    symbols: [symbol],
    triggerMode: 'close',
    cooldownSec: 0,
    expression: {
      kind: 'group',
      op: 'AND',
      children: [
        {
          kind: 'condition',
          id: 'c1',
          timeframe: '5m',
          left: { series: 'price.low' },
          cmp: 'lte',
          right: { type: 'series', series: 'bb.lower', params: { length: 20, mult: 2 } },
        },
      ],
    },
  };
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

describe('accelerated three-day soak', () => {
  it('evaluates 864 future bars without duplicate or lost events', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-soak-'));
    const store = new Store(dir);
    const candles = makeCandles({
      instId: symbol,
      timeframe: '5m',
      count: warmupBars + futureBars,
      endCloseTime: finalEnd,
    });
    const bands = bollingerBands(candles, { length: 20, mult: 2 });
    const touches = new Set<number>();
    for (let index = warmupBars + 80; index < candles.length; index += 97) touches.add(index);
    for (let index = 0; index < candles.length; index++) {
      const lower = bands.lower[index];
      if (lower === null) continue;
      const low = touches.has(index) ? lower - 1 : lower + 1;
      candles[index] = { ...candles[index], low, high: Math.max(candles[index].high, low + 0.1) };
    }
    const initial = candles.slice(0, warmupBars);
    const future = candles.slice(warmupBars);
    const parsed = parseRuleInput(ruleDraft());
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    store.insertRule(parsed.value.draft, true);
    const market = new FakeMarket(baseEnd + 5000);
    market.seed(symbol, '5m', initial);
    const engine = new RuleEngine({
      store,
      market,
      isWebhookConfigured: () => false,
      settleMs: 0,
      tickThrottleMs: 0,
      baselineDelayMs: 0,
    });
    cleanup = async () => {
      await engine.stop();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    };
    await engine.start();
    await wait(10);
    engine.flush();
    await wait(2);
    engine.flush();
    expect(store.listEvents().total).toBe(0);

    const started = performance.now();
    for (const candle of future) {
      market.pushClosed(candle);
      engine.flush();
    }
    const elapsed = performance.now() - started;
    const events = store.listEvents({ limit: 200 });
    expect(events.total).toBe(touches.size);
    expect(new Set(events.events.map((event) => `${event.ruleId}:${event.symbol}:${event.triggerBarTs}`)).size).toBe(events.total);
    expect(events.events.every((event) => event.delivery?.status === 'skipped')).toBe(true);
    expect(events.events.every((event) => event.conditions[0].truth)).toBe(true);
    expect(elapsed).toBeLessThan(20_000);
    expect(market.getClosedCandles(symbol, '5m', 2000).length).toBe(warmupBars + futureBars);
  }, 30_000);
});
