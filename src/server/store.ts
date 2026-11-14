import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  type Candle,
  type ConditionEvaluation,
  type DeliveryInfo,
  type NotificationChannel,
  type EventView,
  type ExpressionNode,
  type Rule,
  type RuleDraft,
  type RuleState,
  type RuleStateStatus,
  type Timeframe,
  type TriggerMode,
} from '../shared/types';

interface RuleRow {
  id: string;
  name: string;
  enabled: number;
  symbols_json: string;
  trigger_mode: string;
  cooldown_sec: number;
  expression_json: string;
  note: string;
  version: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

interface StateRow {
  rule_id: string;
  symbol: string;
  rule_version: number;
  last_truth: number | null;
  last_eval_at: number | null;
  last_eval_bar_close: number | null;
  last_trigger_at: number | null;
  status: string;
  detail_json: string | null;
}

interface EventJoinRow {
  id: string;
  rule_id: string | null;
  rule_name_snapshot: string;
  rule_version: number;
  symbol: string;
  trigger_mode: string;
  trigger_bar_ts: number;
  trigger_bar_close_ts: number;
  trigger_at: number;
  price: number;
  expression_json: string;
  conditions_json: string;
  note: string;
  close_confirmed: number | null;
  created_at: number;
  delivery_status: string | null;
  delivery_channel: string | null;
  delivery_attempts: number | null;
  delivery_http_status: number | null;
  delivery_error: string | null;
  delivery_external_id: string | null;
  delivery_next_attempt_at: number | null;
  delivery_updated_at: number | null;
}

export interface EventInsert {
  id?: string;
  ruleId: string;
  ruleName: string;
  ruleVersion: number;
  symbol: string;
  triggerMode: TriggerMode;
  triggerBarTs: number;
  triggerBarCloseTs: number;
  triggerAt: number;
  price: number;
  expression: ExpressionNode;
  conditions: ConditionEvaluation[];
  note: string;
  closeConfirmed: boolean | null;
}

export interface DeliveryInsert {
  status: DeliveryInfo['status'];
  channel?: NotificationChannel;
  error?: string | null;
  nextAttemptAt?: number | null;
}

export interface EventListFilters {
  limit?: number;
  offset?: number;
  ruleId?: string;
  symbol?: string;
  status?: string;
  from?: number;
  to?: number;
}

export interface EventListResult {
  events: EventView[];
  total: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  symbols_json TEXT NOT NULL,
  trigger_mode TEXT NOT NULL,
  cooldown_sec INTEGER NOT NULL,
  expression_json TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_rules_enabled ON rules(enabled, archived_at);

CREATE TABLE IF NOT EXISTS rule_states (
  rule_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  last_truth INTEGER,
  last_eval_at INTEGER,
  last_eval_bar_close INTEGER,
  last_trigger_at INTEGER,
  status TEXT NOT NULL,
  detail_json TEXT,
  PRIMARY KEY(rule_id, symbol)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  rule_id TEXT,
  rule_name_snapshot TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  trigger_mode TEXT NOT NULL,
  trigger_bar_ts INTEGER NOT NULL,
  trigger_bar_close_ts INTEGER NOT NULL,
  trigger_at INTEGER NOT NULL,
  price REAL NOT NULL,
  expression_json TEXT NOT NULL,
  conditions_json TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  close_confirmed INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_unique ON events(rule_id, symbol, trigger_bar_ts);
CREATE INDEX IF NOT EXISTS idx_events_trigger_at ON events(trigger_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_rule ON events(rule_id, trigger_at DESC);

CREATE TABLE IF NOT EXISTS deliveries (
  event_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL DEFAULT 'discord',
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_http_status INTEGER,
  last_error TEXT,
  external_message_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deliveries_due ON deliveries(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS candles (
  inst_id TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  open_ts INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  vol REAL NOT NULL,
  vol_ccy REAL NOT NULL,
  vol_ccy_quote REAL NOT NULL,
  confirm INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(inst_id, timeframe, open_ts)
);
CREATE INDEX IF NOT EXISTS idx_candles_pair ON candles(inst_id, timeframe, open_ts DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function mapRule(row: RuleRow): Rule {
  return {
    id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    symbols: JSON.parse(row.symbols_json) as string[],
    triggerMode: row.trigger_mode as TriggerMode,
    cooldownSec: row.cooldown_sec,
    expression: JSON.parse(row.expression_json) as ExpressionNode,
    note: row.note,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? null,
  };
}

function mapState(row: StateRow): RuleState {
  return {
    ruleId: row.rule_id,
    symbol: row.symbol,
    ruleVersion: row.rule_version,
    lastTruth: row.last_truth === null ? null : Boolean(row.last_truth),
    lastEvalAt: row.last_eval_at ?? null,
    lastEvalBarClose: row.last_eval_bar_close ?? null,
    lastTriggerAt: row.last_trigger_at ?? null,
    status: row.status as RuleStateStatus,
    detail: row.detail_json ? (JSON.parse(row.detail_json) as Record<string, unknown>) : null,
  };
}

function mapDelivery(row: EventJoinRow): DeliveryInfo | null {
  if (!row.delivery_status) return null;
  return {
    status: row.delivery_status as DeliveryInfo['status'],
    channel: (row.delivery_channel as NotificationChannel | null) ?? 'discord',
    attempts: row.delivery_attempts ?? 0,
    lastHttpStatus: row.delivery_http_status ?? null,
    lastError: row.delivery_error ?? null,
    externalMessageId: row.delivery_external_id ?? null,
    nextAttemptAt: row.delivery_next_attempt_at ?? null,
    updatedAt: row.delivery_updated_at ?? row.created_at,
  };
}

function mapEvent(row: EventJoinRow): EventView {
  return {
    id: row.id,
    ruleId: row.rule_id,
    ruleName: row.rule_name_snapshot,
    ruleVersion: row.rule_version,
    symbol: row.symbol,
    triggerMode: row.trigger_mode as TriggerMode,
    triggerBarTs: row.trigger_bar_ts,
    triggerAt: row.trigger_at,
    price: row.price,
    closeConfirmed: row.close_confirmed === null ? null : Boolean(row.close_confirmed),
    conditions: JSON.parse(row.conditions_json) as ConditionEvaluation[],
    expression: JSON.parse(row.expression_json) as ExpressionNode,
    note: row.note,
    createdAt: row.created_at,
    delivery: mapDelivery(row),
  };
}

export class Store {
  readonly dbPath: string;
  private db: DatabaseSync;
  private closed = false;

  constructor(dataDir: string, filename = 'market-sentinel.db') {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.dbPath = path.join(dataDir, filename);
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    this.db.exec(SCHEMA);
    this.ensureDeliveryChannelColumn();
    try {
      fs.chmodSync(this.dbPath, 0o600);
    } catch {
      // Best effort; the data directory is still restricted.
    }
  }

  private ensureDeliveryChannelColumn(): void {
    const columns = this.db.prepare('PRAGMA table_info(deliveries)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'channel')) {
      this.db.exec("ALTER TABLE deliveries ADD COLUMN channel TEXT NOT NULL DEFAULT 'discord'");
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // ignore
    }
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
      throw error;
    }
  }

  // Rules ------------------------------------------------------------------
  listRules(includeArchived = false): Rule[] {
    const rows = this.db
      .prepare(`SELECT * FROM rules ${includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY created_at DESC`)
      .all() as unknown as RuleRow[];
    return rows.map(mapRule);
  }

  listEnabledRules(): Rule[] {
    const rows = this.db
      .prepare('SELECT * FROM rules WHERE enabled = 1 AND archived_at IS NULL ORDER BY created_at ASC')
      .all() as unknown as RuleRow[];
    return rows.map(mapRule);
  }

  getRule(id: string): Rule | null {
    const row = this.db.prepare('SELECT * FROM rules WHERE id = ?').get(id) as unknown as RuleRow | undefined;
    return row ? mapRule(row) : null;
  }

  insertRule(draft: RuleDraft, enabled: boolean): Rule {
    const now = Date.now();
    const rule: Rule = {
      ...draft,
      id: randomUUID(),
      enabled,
      version: 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO rules
          (id, name, enabled, symbols_json, trigger_mode, cooldown_sec, expression_json, note, version, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        rule.id,
        rule.name,
        rule.enabled ? 1 : 0,
        JSON.stringify(rule.symbols),
        rule.triggerMode,
        rule.cooldownSec,
        JSON.stringify(rule.expression),
        rule.note ?? '',
        rule.version,
        rule.createdAt,
        rule.updatedAt,
      );
    return rule;
  }

  updateRule(id: string, draft: RuleDraft, enabled?: boolean): Rule | null {
    const current = this.getRule(id);
    if (!current || current.archivedAt) return null;
    const nextEnabled = enabled === undefined ? current.enabled : enabled;
    const version = current.version + 1;
    const updatedAt = Date.now();
    this.db
      .prepare(
        `UPDATE rules SET name=?, symbols_json=?, trigger_mode=?, cooldown_sec=?, expression_json=?, note=?,
         enabled=?, version=?, updated_at=? WHERE id=? AND archived_at IS NULL`,
      )
      .run(
        draft.name,
        JSON.stringify(draft.symbols),
        draft.triggerMode,
        draft.cooldownSec,
        JSON.stringify(draft.expression),
        draft.note ?? '',
        nextEnabled ? 1 : 0,
        version,
        updatedAt,
        id,
      );
    return this.getRule(id);
  }

  setRuleEnabled(id: string, enabled: boolean): Rule | null {
    const current = this.getRule(id);
    if (!current || current.archivedAt) return null;
    this.db.prepare('UPDATE rules SET enabled=?, updated_at=? WHERE id=?').run(enabled ? 1 : 0, Date.now(), id);
    return this.getRule(id);
  }

  archiveRule(id: string): boolean {
    const now = Date.now();
    const result = this.db
      .prepare('UPDATE rules SET enabled=0, archived_at=?, updated_at=? WHERE id=? AND archived_at IS NULL')
      .run(now, now, id);
    return result.changes > 0;
  }

  // Rule states ------------------------------------------------------------
  getRuleState(ruleId: string, symbol: string): RuleState | null {
    const row = this.db
      .prepare('SELECT * FROM rule_states WHERE rule_id=? AND symbol=?')
      .get(ruleId, symbol) as unknown as StateRow | undefined;
    return row ? mapState(row) : null;
  }

  listRuleStates(ruleId?: string): RuleState[] {
    const rows = ruleId
      ? (this.db.prepare('SELECT * FROM rule_states WHERE rule_id=? ORDER BY symbol').all(ruleId) as unknown as StateRow[])
      : (this.db.prepare('SELECT * FROM rule_states ORDER BY rule_id, symbol').all() as unknown as StateRow[]);
    return rows.map(mapState);
  }

  upsertRuleState(state: RuleState): void {
    this.db
      .prepare(
        `INSERT INTO rule_states
          (rule_id, symbol, rule_version, last_truth, last_eval_at, last_eval_bar_close, last_trigger_at, status, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(rule_id, symbol) DO UPDATE SET
          rule_version=excluded.rule_version,
          last_truth=excluded.last_truth,
          last_eval_at=excluded.last_eval_at,
          last_eval_bar_close=excluded.last_eval_bar_close,
          last_trigger_at=excluded.last_trigger_at,
          status=excluded.status,
          detail_json=excluded.detail_json`,
      )
      .run(
        state.ruleId,
        state.symbol,
        state.ruleVersion,
        state.lastTruth === null ? null : state.lastTruth ? 1 : 0,
        state.lastEvalAt,
        state.lastEvalBarClose,
        state.lastTriggerAt,
        state.status,
        state.detail ? JSON.stringify(state.detail) : null,
      );
  }

  deleteRuleStates(ruleId: string): void {
    this.db.prepare('DELETE FROM rule_states WHERE rule_id=?').run(ruleId);
  }

  deleteRuleStateForSymbols(ruleId: string, symbols: string[]): void {
    if (!symbols.length) return;
    const placeholders = symbols.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM rule_states WHERE rule_id=? AND symbol NOT IN (${placeholders})`).run(ruleId, ...symbols);
  }

  // Events -----------------------------------------------------------------
  insertEventIfNew(event: EventInsert, delivery: DeliveryInsert): { inserted: boolean; eventId: string } {
    const id = event.id ?? randomUUID();
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO events
          (id, rule_id, rule_name_snapshot, rule_version, symbol, trigger_mode, trigger_bar_ts,
           trigger_bar_close_ts, trigger_at, price, expression_json, conditions_json, note, close_confirmed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        event.ruleId,
        event.ruleName,
        event.ruleVersion,
        event.symbol,
        event.triggerMode,
        event.triggerBarTs,
        event.triggerBarCloseTs,
        event.triggerAt,
        event.price,
        JSON.stringify(event.expression),
        JSON.stringify(event.conditions),
        event.note,
        event.closeConfirmed === null ? null : event.closeConfirmed ? 1 : 0,
        now,
      );
    if (result.changes === 0) return { inserted: false, eventId: id };
    this.db
      .prepare(
        `INSERT INTO deliveries (event_id, channel, status, attempts, next_attempt_at, last_error, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
      )
      .run(id, delivery.channel ?? 'discord', delivery.status, delivery.nextAttemptAt ?? null, delivery.error ?? null, now, now);
    return { inserted: true, eventId: id };
  }

  updateCloseConfirmation(ruleId: string, symbol: string, triggerBarTs: number, confirmed: boolean): void {
    this.db
      .prepare('UPDATE events SET close_confirmed=? WHERE rule_id=? AND symbol=? AND trigger_bar_ts=?')
      .run(confirmed ? 1 : 0, ruleId, symbol, triggerBarTs);
  }

  private eventSelect(): string {
    return `SELECT e.*, d.status AS delivery_status, d.channel AS delivery_channel, d.attempts AS delivery_attempts,
      d.last_http_status AS delivery_http_status, d.last_error AS delivery_error,
      d.external_message_id AS delivery_external_id, d.next_attempt_at AS delivery_next_attempt_at,
      d.updated_at AS delivery_updated_at
      FROM events e LEFT JOIN deliveries d ON d.event_id = e.id`;
  }

  getEvent(id: string): EventView | null {
    const row = this.db.prepare(`${this.eventSelect()} WHERE e.id=?`).get(id) as unknown as EventJoinRow | undefined;
    return row ? mapEvent(row) : null;
  }

  getEventByUnique(ruleId: string, symbol: string, triggerBarTs: number): EventView | null {
    const row = this.db
      .prepare(`${this.eventSelect()} WHERE e.rule_id=? AND e.symbol=? AND e.trigger_bar_ts=?`)
      .get(ruleId, symbol, triggerBarTs) as unknown as EventJoinRow | undefined;
    return row ? mapEvent(row) : null;
  }

  listEvents(filters: EventListFilters = {}): EventListResult {
    const limit = Math.min(200, Math.max(1, filters.limit ?? 50));
    const offset = Math.max(0, filters.offset ?? 0);
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filters.ruleId) {
      clauses.push('e.rule_id = ?');
      params.push(filters.ruleId);
    }
    if (filters.symbol) {
      clauses.push('e.symbol = ?');
      params.push(filters.symbol);
    }
    if (filters.status) {
      if (filters.status === 'failed') {
        clauses.push("d.status = 'dead'");
      } else {
        clauses.push('d.status = ?');
        params.push(filters.status);
      }
    }
    if (filters.from) {
      clauses.push('e.trigger_at >= ?');
      params.push(filters.from);
    }
    if (filters.to) {
      clauses.push('e.trigger_at <= ?');
      params.push(filters.to);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS n FROM events e LEFT JOIN deliveries d ON d.event_id=e.id${where}`)
      .get(...params) as { n: number };
    const rows = this.db
      .prepare(`${this.eventSelect()}${where} ORDER BY e.trigger_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as EventJoinRow[];
    return { events: rows.map(mapEvent), total: Number(totalRow.n) };
  }

  countEventsSince(since: number): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE trigger_at >= ?').get(since) as { n: number };
    return Number(row.n);
  }

  countEventsForRuleSince(ruleId: string, since: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM events WHERE rule_id=? AND trigger_at >= ?')
      .get(ruleId, since) as { n: number };
    return Number(row.n);
  }

  countsByRuleSince(since: number): Map<string, number> {
    const rows = this.db
      .prepare('SELECT rule_id, COUNT(*) AS n FROM events WHERE rule_id IS NOT NULL AND trigger_at >= ? GROUP BY rule_id')
      .all(since) as { rule_id: string; n: number }[];
    return new Map(rows.map((r) => [r.rule_id, Number(r.n)]));
  }

  lastTriggerForRule(ruleId: string): number | null {
    const row = this.db
      .prepare('SELECT MAX(trigger_at) AS ts FROM events WHERE rule_id=?')
      .get(ruleId) as { ts: number | null };
    return row.ts ?? null;
  }

  countDeliveriesSince(since: number): { sent: number; total: number } {
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN d.status='sent' THEN 1 ELSE 0 END) AS sent,
           COUNT(*) AS total
         FROM deliveries d JOIN events e ON e.id=d.event_id
         WHERE e.trigger_at >= ? AND d.status != 'skipped'`,
      )
      .get(since) as { sent: number | null; total: number };
    return { sent: Number(row.sent ?? 0), total: Number(row.total ?? 0) };
  }

  pruneEvents(cutoff: number): number {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM deliveries WHERE event_id IN (SELECT id FROM events WHERE created_at < ?)').run(cutoff);
      const result = this.db.prepare('DELETE FROM events WHERE created_at < ?').run(cutoff);
      return Number(result.changes);
    });
  }

  // Deliveries -------------------------------------------------------------
  getDelivery(eventId: string): DeliveryInfo | null {
    const row = this.db.prepare('SELECT * FROM deliveries WHERE event_id=?').get(eventId) as unknown as
      | {
          event_id: string;
          channel: string;
          status: string;
          attempts: number;
          next_attempt_at: number | null;
          last_http_status: number | null;
          last_error: string | null;
          external_message_id: string | null;
          updated_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      status: row.status as DeliveryInfo['status'],
      channel: row.channel as NotificationChannel,
      attempts: row.attempts,
      lastHttpStatus: row.last_http_status,
      lastError: row.last_error,
      externalMessageId: row.external_message_id,
      nextAttemptAt: row.next_attempt_at,
      updatedAt: row.updated_at,
    };
  }

  listDueDeliveries(now: number, limit = 10): EventView[] {
    const rows = this.db
      .prepare(
        `${this.eventSelect()}
         WHERE d.status='pending' AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)
         ORDER BY e.trigger_at ASC LIMIT ?`,
      )
      .all(now, limit) as unknown as EventJoinRow[];
    return rows.map(mapEvent);
  }

  resetInflightDeliveries(): void {
    this.db
      .prepare("UPDATE deliveries SET status='pending', updated_at=? WHERE status='sending'")
      .run(Date.now());
  }

  claimDelivery(eventId: string): boolean {
    const now = Date.now();
    const result = this.db
      .prepare("UPDATE deliveries SET status='sending', updated_at=? WHERE event_id=? AND status='pending'")
      .run(now, eventId);
    return result.changes > 0;
  }

  markDeliverySent(eventId: string, externalId: string | null): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE deliveries SET status='sent', attempts=attempts+1, next_attempt_at=NULL,
         last_http_status=200, last_error=NULL, external_message_id=?, updated_at=? WHERE event_id=?`,
      )
      .run(externalId, now, eventId);
  }

  markDeliveryFailure(eventId: string, status: 'pending' | 'dead', error: string, httpStatus: number | null, nextAttemptAt: number | null): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE deliveries SET status=?, attempts=attempts+1, next_attempt_at=?,
         last_http_status=?, last_error=?, updated_at=? WHERE event_id=?`,
      )
      .run(status, nextAttemptAt, httpStatus, error.slice(0, 1000), now, eventId);
  }

  retryDelivery(eventId: string): boolean {
    const row = this.db.prepare('SELECT status FROM deliveries WHERE event_id=?').get(eventId) as { status: string } | undefined;
    if (!row) return false;
    if (!['dead', 'skipped', 'pending'].includes(row.status)) return false;
    const result = this.db
      .prepare("UPDATE deliveries SET status='pending', attempts=0, next_attempt_at=NULL, last_error=NULL, updated_at=? WHERE event_id=?")
      .run(Date.now(), eventId);
    return result.changes > 0;
  }

  deliveryQueueCounts(): { pending: number; dead: number; sent: number; skipped: number } {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM deliveries GROUP BY status').all() as {
      status: string;
      n: number;
    }[];
    const counts = { pending: 0, dead: 0, sent: 0, skipped: 0 };
    for (const row of rows) {
      if (row.status === 'pending' || row.status === 'sending') counts.pending += Number(row.n);
      else if (row.status === 'dead') counts.dead = Number(row.n);
      else if (row.status === 'sent') counts.sent = Number(row.n);
      else if (row.status === 'skipped') counts.skipped = Number(row.n);
    }
    return counts;
  }

  // Candles ----------------------------------------------------------------
  upsertCandles(candles: Candle[]): void {
    if (!candles.length) return;
    const statement = this.db.prepare(
      `INSERT INTO candles (inst_id, timeframe, open_ts, open, high, low, close, vol, vol_ccy, vol_ccy_quote, confirm, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(inst_id, timeframe, open_ts) DO UPDATE SET
         open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close,
         vol=excluded.vol, vol_ccy=excluded.vol_ccy, vol_ccy_quote=excluded.vol_ccy_quote,
         confirm=excluded.confirm, updated_at=excluded.updated_at`,
    );
    this.transaction(() => {
      const now = Date.now();
      for (const c of candles) {
        statement.run(
          c.instId,
          c.timeframe,
          c.openTime,
          c.open,
          c.high,
          c.low,
          c.close,
          c.vol,
          c.volCcy,
          c.volCcyQuote,
          c.confirm ? 1 : 0,
          now,
        );
      }
    });
  }

  getCandles(instId: string, timeframe: Timeframe, limit = 300, onlyClosed = true): Candle[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM candles WHERE inst_id=? AND timeframe=? ${onlyClosed ? 'AND confirm=1' : ''}
         ORDER BY open_ts DESC LIMIT ?`,
      )
      .all(instId, timeframe, limit) as unknown as Record<string, number | string>[];
    return rows
      .map((row) => ({
        instId: String(row.inst_id),
        timeframe: String(row.timeframe) as Timeframe,
        openTime: Number(row.open_ts),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.vol_ccy_quote),
        vol: Number(row.vol),
        volCcy: Number(row.vol_ccy),
        volCcyQuote: Number(row.vol_ccy_quote),
        confirm: Boolean(row.confirm),
      }))
      .reverse();
  }

  countCandles(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM candles').get() as { n: number }).n);
  }

  pruneCandles(now: number): void {
    this.db.prepare('DELETE FROM candles WHERE timeframe=? AND open_ts < ?').run('1m', now - 7 * 86_400_000);
    this.db.prepare('DELETE FROM candles WHERE timeframe=? AND open_ts < ?').run('3m', now - 14 * 86_400_000);
    this.db.prepare('DELETE FROM candles WHERE timeframe NOT IN (\'1m\',\'3m\') AND open_ts < ?').run(now - 90 * 86_400_000);
  }

  // Settings/meta ----------------------------------------------------------
  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
      .run(key, value, Date.now());
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }

  databaseBytes(): number {
    try {
      return fs.statSync(this.dbPath).size;
    } catch {
      return 0;
    }
  }

  countArchivedRules(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM rules WHERE archived_at IS NOT NULL').get() as { n: number }).n);
  }
}
