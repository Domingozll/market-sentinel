import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/server/store';
import { RuleEngine } from '../../src/server/rules/engine';
import { parseRuleInput } from '../../src/server/rules/schema';
import { FakeMarket, makeCandle, makeCandles, wait } from '../helpers/fake-market';
import type { Candle, Rule, RuleDraft } from '../../src/shared/types';

const endClose = Date.parse('2026-11-09T16:00:00+08:00');
const symbolA = 'BTC-USDT-SWAP';
const symbolB = 'ETH-USDT-SWAP';

function touchDraft(overrides: Partial<RuleDraft> = {}): RuleDraft {
  return {
    name: '多品种/重启测试',
    symbols: [symbolA],
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

function seed(market: FakeMarket, instId: string): Candle[] {
  const candles = makeCandles({ instId, timeframe: '5m', count: 320, endCloseTime: endClose });
  const last = candles.at(-1)!;
  candles[candles.length - 1] = { ...last, low: last.close - 0.01, high: last.close + 1 };
  market.seed(instId, '5m', candles);
  return candles;
}

function makeRule(draft: RuleDraft, id = '00000000-0000-4000-8000-000000000101'): Rule {
  const parsed = parseRuleInput(draft);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return {
    ...parsed.value.draft,
    id,
    enabled: true,
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    archivedAt: null,
  };
}

interface Ctx {
  dir: string;
  store: Store;
  market: FakeMarket;
  engine: RuleEngine;
  ruleId: string;
  cleanup: () => Promise<void>;
}

async function makeContext(draft: RuleDraft): Promise<Ctx> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-extra-'));
  const store = new Store(dir);
  const rule = makeRule(draft);
  const inserted = store.insertRule(
    { name: rule.name, symbols: rule.symbols, triggerMode: rule.triggerMode, cooldownSec: rule.cooldownSec, expression: rule.expression, note: rule.note },
    true,
  );
  const market = new FakeMarket(endClose + 5000);
  for (const symbol of rule.symbols) seed(market, symbol);
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
    ruleId: inserted.id,
    cleanup: async () => {
      await engine.stop();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

let ctx: Ctx | null = null;
afterEach(async () => {
  await ctx?.cleanup();
  ctx = null;
});

describe('RuleEngine multi-symbol and restart', () => {
  it('keeps per-symbol state and only triggers the touched symbol', async () => {
    ctx = await makeContext(touchDraft({ symbols: [symbolA, symbolB] }));
    expect(ctx.engine.getStatesForRule(ctx.ruleId)).toHaveLength(2);
    expect(ctx.engine.getStatesForRule(ctx.ruleId).every((s) => s.status === 'armed')).toBe(true);
    const prev = ctx.market.getLatestClosed(symbolA, '5m')!;
    ctx.market.pushClosed(makeCandle({
      instId: symbolA, timeframe: '5m', openTime: endClose, open: prev.close,
      high: prev.close + 1, low: 0, close: prev.close,
    }));
    ctx.engine.flush();
    const events = ctx.store.listEvents();
    expect(events.total).toBe(1);
    expect(events.events[0].symbol).toBe(symbolA);
    const states = ctx.engine.getStatesForRule(ctx.ruleId);
    expect(states.find((s) => s.symbol === symbolA)?.status).toBe('satisfied');
    expect(states.find((s) => s.symbol === symbolB)?.status).toBe('armed');
  });


  it('suppresses a close signal discovered more than two minutes late', async () => {
    ctx = await makeContext(touchDraft());
    const prev = ctx.market.getLatestClosed(symbolA, '5m')!;
    const bar = makeCandle({
      instId: symbolA, timeframe: '5m', openTime: endClose, open: prev.close,
      high: prev.close + 1, low: 0, close: prev.close,
    });
    ctx.market.pushClosed(bar);
    ctx.market.setNow(endClose + 300_000 + 180_000);
    const missed: unknown[] = [];
    ctx.engine.on('missedTrigger', (value) => missed.push(value));
    ctx.engine.evaluateNow(ctx.ruleId, symbolA, 'closed');
    expect(ctx.store.listEvents().total).toBe(0);
    expect(missed).toHaveLength(1);
    expect(ctx.engine.getStatesForRule(ctx.ruleId)[0].lastTruth).toBe(true);
  });

  it('does not recreate a prior event after an application restart', async () => {
    ctx = await makeContext(touchDraft());
    const prev = ctx.market.getLatestClosed(symbolA, '5m')!;
    const trigger = makeCandle({
      instId: symbolA, timeframe: '5m', openTime: endClose, open: prev.close,
      high: prev.close + 1, low: 0, close: prev.close,
    });
    ctx.market.pushClosed(trigger);
    ctx.engine.flush();
    await wait(5);
    expect(ctx.store.listEvents().total).toBe(1);
    await ctx.engine.stop();
    const second = new RuleEngine({
      store: ctx.store,
      market: ctx.market,
      isWebhookConfigured: () => false,
      settleMs: 0,
      tickThrottleMs: 0,
      baselineDelayMs: 0,
    });
    await second.start();
    await wait(10);
    second.flush();
    await wait(2);
    second.flush();
    ctx.market.emit('closed', trigger, 'ws');
    second.flush();
    expect(ctx.store.listEvents().total).toBe(1);
    await second.stop();
    // Replace the cleanup engine with a fresh no-op to avoid double-stop issues.
    ctx.engine = second;
  });
});

describe('RuleEngine intrabar confirmation', () => {
  it('marks an intrabar event closed-confirmed true when the close still satisfies', async () => {
    ctx = await makeContext(touchDraft({ triggerMode: 'intrabar' }));
    const prev = ctx.market.getLatestClosed(symbolA, '5m')!;
    const forming = makeCandle({
      instId: symbolA, timeframe: '5m', openTime: endClose, open: prev.close,
      high: prev.close + 1, low: 0, close: prev.close, confirm: false,
    });
    ctx.market.setNow(endClose + 60_000);
    ctx.market.pushTick(forming);
    ctx.engine.flush();
    const event = ctx.store.listEvents().events[0];
    expect(event.closeConfirmed).toBeNull();
    ctx.market.pushClosed({ ...forming, confirm: true });
    ctx.engine.flush();
    const after = ctx.store.getEvent(event.id)!;
    expect(after.closeConfirmed).toBe(true);
    expect(ctx.store.listEvents().total).toBe(1);
  });
});
