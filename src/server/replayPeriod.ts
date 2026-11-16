import type { ReplayPeriod } from '../shared/types';

const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 366;
const formatterCache = new Map<string, Intl.DateTimeFormat>();

export class ReplayPeriodError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ReplayPeriodError';
  }
}

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  formatterCache.set(timezone, formatter);
  return formatter;
}

function partsInZone(ms: number, timezone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = formatterFor(timezone).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
  };
}

function validateTimezone(timezone: string): void {
  if (!timezone || typeof timezone !== 'string') throw new ReplayPeriodError('回放时区不能为空');
  try {
    formatterFor(timezone).format(0);
  } catch {
    throw new ReplayPeriodError(`回放时区不合法：${timezone}`);
  }
}

function parseDate(value: unknown, label: string): { year: number; month: number; day: number } {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ReplayPeriodError(`${label}必须是 YYYY-MM-DD 格式`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day
  ) {
    throw new ReplayPeriodError(`${label}不是有效日期`);
  }
  return { year, month, day };
}

function addDays(date: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

/** Convert a wall-clock time in an IANA timezone to a UTC epoch. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): number {
  validateTimezone(timezone);
  const target = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const p = partsInZone(guess, timezone);
    const actual = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
    const diff = target - actual;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

function parseClock(value: unknown, label: string, allow24: boolean): number {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) {
    throw new ReplayPeriodError(`${label}必须是 HH:MM 格式`);
  }
  const [hour, minute] = value.split(':').map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new ReplayPeriodError(`${label}不是有效时间`);
  }
  if (allow24 && hour === 24 && minute === 0) return 1440;
  if (hour < 0 || hour > 23) throw new ReplayPeriodError(`${label}不是有效时间`);
  return hour * 60 + minute;
}

/**
 * Normalize a custom replay range. Dates are inclusive calendar dates in the
 * selected timezone; the daily window is evaluated in that same timezone.
 */
export function normalizeReplayPeriod(raw: unknown, now: number): ReplayPeriod {
  if (!raw || typeof raw !== 'object') throw new ReplayPeriodError('自定义回放时段格式不合法');
  const input = raw as Record<string, unknown>;
  const timezone = typeof input.timezone === 'string' ? input.timezone.trim() : '';
  validateTimezone(timezone);
  const startDate = parseDate(input.startDate, '开始日期');
  const endDate = parseDate(input.endDate, '结束日期');
  const startMidnight = zonedTimeToUtc(startDate.year, startDate.month, startDate.day, 0, 0, timezone);
  const dayAfterEnd = addDays(endDate, 1);
  const endExclusive = zonedTimeToUtc(dayAfterEnd.year, dayAfterEnd.month, dayAfterEnd.day, 0, 0, timezone);
  if (endExclusive <= startMidnight) throw new ReplayPeriodError('结束日期必须不早于开始日期');
  if (endExclusive - startMidnight > MAX_RANGE_DAYS * DAY_MS) {
    throw new ReplayPeriodError(`自定义回放最多支持 ${MAX_RANGE_DAYS} 天`);
  }
  if (startMidnight > now) throw new ReplayPeriodError('开始日期不能晚于当前时间');
  const to = Math.min(endExclusive, now);
  if (to <= startMidnight) throw new ReplayPeriodError('所选日期范围内没有可回放的时间');

  const allDay = input.allDay === true;
  let dailyStartMinute = 0;
  let dailyEndMinute = 1440;
  if (!allDay) {
    dailyStartMinute = parseClock(input.dailyStart, '每日开始时间', false);
    dailyEndMinute = parseClock(input.dailyEnd, '每日结束时间', true);
    if (dailyStartMinute === dailyEndMinute) {
      throw new ReplayPeriodError('每日开始时间和结束时间不能相同；需要全天请勾选“全天”');
    }
  }

  return {
    from: startMidnight,
    to,
    timezone,
    dailyStartMinute,
    dailyEndMinute,
    allDay,
  };
}

/** Intl returns local wall-clock parts; this is the minute of day in the period timezone. */
export function minuteOfDayInZone(ms: number, timezone: string): number {
  const p = partsInZone(ms, timezone);
  return p.hour * 60 + p.minute;
}

export function isWithinDailyWindow(ms: number, period: ReplayPeriod): boolean {
  if (period.allDay) return true;
  const minute = minuteOfDayInZone(ms, period.timezone);
  if (period.dailyStartMinute < period.dailyEndMinute) {
    return minute >= period.dailyStartMinute && minute < period.dailyEndMinute;
  }
  // Overnight window, for example 22:00–06:00.
  return minute >= period.dailyStartMinute || minute < period.dailyEndMinute;
}

export function replayRangeDays(period: ReplayPeriod): number {
  return Math.max(1, (period.to - period.from) / DAY_MS);
}

export function formatLocalDate(ms: number, timezone: string): string {
  const p = partsInZone(ms, timezone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function formatLocalTime(ms: number, timezone: string): string {
  const p = partsInZone(ms, timezone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}
