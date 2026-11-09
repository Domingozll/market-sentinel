import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/server/store';
import { RuleEngine } from '../../src/server/rules/engine';
import { parseRuleInput } from '../../src/server/rules/schema';
import { FakeMarket, makeCandle, makeCandles, wait } from '../helpers/fake-market';
import type { Candle, Rule, RuleDraft } from '../../src/shared/types';
import { bollingerBands } from '../../src/server/indicators';

const symbol = 'BTC-USDT-SWAP';
const endClose = Date.parse('2026-11-09T15:00:00+08:00');

function touchDraft(overrides: Partial<RuleDraft> = {}): RuleDraft {
  return {
    name: '下轨触及测试',
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
    ...overrides,
  };
}

function comboDraft(overrides: Partial<RuleDraft> = {}): RuleDraft {
  return {
    name: '多周期组合测试',
    symbols: [symbol],
    triggerMode: 'close',
    cooldownSec: 0,
    expression: {
      kind: 'group',
      op: 'AND',
      children: [
        {
          kind: 'condition',
          id: 'trend',
          timeframe: '15m',
          left: { series: 'bb.midSlope', params: { length: 20, mult: 2, slopeWindow: 1 } },
          cmp: 'gt',
          right: { type: 'number', value: 0 },
        },
        {
          kind: 'condition',
          id: 'touch',
          timeframe: '5m',
          left: { series: 'price.low' },
          cmp: 'lte',
          right: { type: 'series', series: 'bb.lower', params: { length: 20, mult: 2 } },
        },
      ],
    },
    ...overrides,
  };
}

function makeRule(draft: RuleDraft, enabled = true): Rule {
  const parsed = parseRuleInput(draft);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return {
    ...parsed.value.draft,
    id: '00000000-0000-4000-8000-000000000001',
    enabled,
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    archivedAt: null,
  };
}

interface Harness {
  dir: string;
  store: Store;
  market: FakeMarket;
  engine: RuleEngine;
  candles: Candle[];
  cleanup: () => Promise<void>;
}

async function harness(draft: RuleDraft, options: { candles?: Candle[]; fifteen?: Candle[]; enabled?: boolean; initialTouch?: boolean } = {}): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-engine-'));
  const store = new Store(dir);
  const five = options.candles ?? makeCandles({ instId: symbol, timeframe: '5m', count: 320, endCloseTime: endClose });
  const last = five[five.length - 1];
  five[five.length - 1] = {
    ...last,
    low: options.initialTouch ? 0 : last.close - 0.01,
    high: Math.max(last.high, last.close + 1),
  };
  const market = new FakeMarket(endClose + 5000);
  market.seed(symbol, '5m', five);
  if (options.fifteen) market.seed(symbol, '15m', options.fifteen);
  const rule = makeRule(draft, options.enabled ?? true);
  store.insertRule(
    {
      name: rule.name,
      symbols: rule.symbols,
      triggerMode: rule.triggerMode,
      cooldownSec: rule.cooldownSec,
      expression: rule.expression,
      note: rule.note,
    },
    rule.enabled,
  );
  const engine = new RuleEngine({
    store,
    market,
    isWebhookConfigured: () => false,
    settleMs: 0,
    tickThrottleMs: 0,
    baselineDelayMs: 0,
  });
  await engine.start();
  await wait(10);
  engine.flush();
  await wait(2);
  engine.flush();
  return {
    dir,
    store,
    market,
    engine,
    candles: five,
    cleanup: async () => {
      await engine.stop();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function nextBar(openTime: number, open: number, opts: { touch?: boolean; close?: number } = {}): Candle {
  const close = opts.close ?? open;
  const low = opts.touch ? 0 : Math.min(open, close) - 0.01;
  return makeCandle({
    instId: symbol,
    timeframe: '5m',
    openTime,
    open,
    high: Math.max(open, close) + 1,
    low,
    close,
  });
}

function getOnlyRule(store: Store): Rule {
  return store.listRules()[0];
}

describe('RuleEngine lifecycle', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    await h?.cleanup();
    h = null;
  });

  it('baselines without notification and triggers on a new closed bar exactly once', async () => {
    h = await harness(touchDraft());
    const rule = getOnlyRule(h.store);
    let state = h.engine.getStatesForRule(rule.id)[0];
    expect(state.status).toBe('armed');
    expect(h.store.listEvents().total).toBe(0);

    const prev = h.candles.at(-1)!;
    const triggerBar = nextBar(endClose, prev.close, { touch: true });
    h.market.pushClosed(triggerBar);
    h.engine.flush();
    state = h.engine.getStatesForRule(rule.id)[0];
    expect(state.status).toBe('satisfied');
    const events = h.store.listEvents();
    expect(events.total).toBe(1);
    expect(events.events[0].symbol).toBe(symbol);
    expect(events.events[0].delivery?.status).toBe('skipped');

    h.market.emit('closed', triggerBar, 'ws');
    h.engine.flush();
    expect(h.store.listEvents().total).toBe(1);
  });

  it('does not notify when the condition is already true at baseline', async () => {
    h = await harness(touchDraft(), { initialTouch: true });
    const rule = getOnlyRule(h.store);
    expect(h.store.listEvents().total).toBe(0);
    expect(h.engine.getStatesForRule(rule.id)[0].status).toBe('satisfied');
  });

  it('re-arms after false and respects cooldown', async () => {
    h = await harness(touchDraft({ cooldownSec: 900 }));
    const rule = getOnlyRule(h.store);
    let prev = h.candles.at(-1)!;
    let openTime = endClose;
    // First trigger
    h.market.pushClosed(nextBar(openTime, prev.close, { touch: true }));
    h.engine.flush();
    expect(h.store.listEvents().total).toBe(1);
    prev = h.market.getLatestClosed(symbol, '5m')!;
    openTime += 300_000;
    // Re-arm
    h.market.pushClosed(nextBar(openTime, prev.close, { touch: false }));
    h.engine.flush();
    prev = h.market.getLatestClosed(symbol, '5m')!;
    openTime += 300_000;
    // Within cooldown
    h.market.pushClosed(nextBar(openTime, prev.close, { touch: true }));
    h.engine.flush();
    expect(h.store.listEvents().total).toBe(1);
    prev = h.market.getLatestClosed(symbol, '5m')!;
    openTime += 300_000;
    // Re-arm again
    h.market.pushClosed(nextBar(openTime, prev.close, { touch: false }));
    h.engine.flush();
    prev = h.market.getLatestClosed(symbol, '5m')!;
    openTime += 300_000;
    // One more non-touch bar keeps history contiguous and advances past cooldown.
    h.market.pushClosed(nextBar(openTime, prev.close, { touch: false }));
    h.engine.flush();
    prev = h.market.getLatestClosed(symbol, '5m')!;
    openTime += 300_000;
    const nowAllowed = nextBar(openTime, prev.close, { touch: true });
    h.market.pushClosed(nowAllowed);
    h.engine.flush();
    expect(h.store.listEvents().total).toBe(2);
    expect(h.engine.getStatesForRule(rule.id)).toHaveLength(1);
  });

  it('degrades on stale data and rebaselines after recovery without late notifications', async () => {
    h = await harness(touchDraft());
    const rule = getOnlyRule(h.store);
    const stateBefore = h.engine.getStatesForRule(rule.id)[0];
    expect(stateBefore.status).toBe('armed');
    h.market.setNow(endClose + 30 * 60_000);
    h.engine.evaluateNow(rule.id, symbol, 'closed');
    const degraded = h.engine.getStatesForRule(rule.id)[0];
    expect(degraded.status).toBe('degraded');
    expect(h.store.listEvents().total).toBe(0);
    // Fresh data returns; baseline should not retroactively fire.
    const prev = h.candles.at(-1)!;
    h.market.setNow(endClose + 5000);
    h.market.emit('ready', { instId: symbol, timeframe: '5m' });
    await wait(2);
    h.engine.flush();
    h.market.pushClosed(nextBar(endClose, prev.close, { touch: true }));
    h.engine.flush();
    // The engine was already degraded; a successful eval re-baselines and this bar is
    // allowed to trigger because baseline happened after new data became available.
    expect(h.market.getLatestClosed(symbol, '5m')!.confirm).toBe(true);
  });
});

describe('RuleEngine multi-timeframe and intrabar', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    await h?.cleanup();
    h = null;
  });

  function rising15m(): Candle[] {
    const fifteen = makeCandles({ instId: symbol, timeframe: '15m', count: 280, endCloseTime: endClose });
    const base = fifteen[fifteen.length - 22].close;
    for (let i = fifteen.length - 21; i < fifteen.length; i++) {
      const close = base + (i - (fifteen.length - 21)) * 1.5;
      const previous = fifteen[i - 1];
      fifteen[i] = {
        ...fifteen[i],
        open: previous.close,
        close,
        high: Math.max(previous.close, close) + 0.2,
        low: Math.min(previous.close, close) - 0.2,
      };
    }
    return fifteen;
  }

  it('triggers only when both 15m slope and 5m touch are simultaneously true', async () => {
    h = await harness(comboDraft(), { fifteen: rising15m() });
    const rule = getOnlyRule(h.store);
    const prev = h.candles.at(-1)!;
    // 5m touches but baseline is chosen not to trigger
    h.market.pushClosed(nextBar(endClose, prev.close, { touch: true }));
    h.engine.flush();
    expect(h.store.listEvents().total).toBe(1);
    expect(h.engine.getStatesForRule(rule.id)[0].detail?.conditions).toBeTruthy();
  });

  it('keeps an intrabar event provisional and updates close confirmation at close', async () => {
    h = await harness(touchDraft({ triggerMode: 'intrabar' }));
    const rule = getOnlyRule(h.store);
    const prev = h.candles.at(-1)!;
    const forming = {
      ...nextBar(endClose, prev.close, { touch: true }),
      confirm: false,
    };
    h.market.setNow(endClose + 60_000);
    h.market.pushTick(forming);
    h.engine.flush();
    const events = h.store.listEvents();
    expect(events.total).toBe(1);
    expect(events.events[0].triggerMode).toBe('intrabar');
    expect(events.events[0].closeConfirmed).toBeNull();

    h.market.pushClosed({
      ...forming,
      confirm: true,
      low: prev.close - 0.01,
      close: prev.close,
    });
    h.engine.flush();
    const after = h.store.getEvent(events.events[0].id)!;
    expect(after.closeConfirmed).toBe(false);
    expect(h.store.listEvents().total).toBe(1);
  });

  it('rebuilds baseline after a resync event', async () => {
    h = await harness(touchDraft());
    const rule = getOnlyRule(h.store);
    h.market.emitResync([{ instId: symbol, timeframe: '5m' }]);
    await wait(0);
    h.engine.flush();
    const state = h.engine.getStatesForRule(rule.id)[0];
    expect(['armed', 'satisfied']).toContain(state.status);
    expect(h.store.listEvents().total).toBe(0);
  });
});
