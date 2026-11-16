/**
 * Regular NYSE/Nasdaq full-day closures. Early-close sessions (for example the
 * day after Thanksgiving) are still trading days and are deliberately allowed.
 *
 * Rules are evaluated in the America/New_York calendar. The small unscheduled
 * closure list is included for historical replay accuracy.
 */
const NY_ZONE = 'America/New_York';
const dateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: NY_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
});

interface NyDate {
  year: number;
  month: number;
  day: number;
  weekday: number;
  key: string;
}

function utcKey(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toISOString().slice(0, 10);
}

function utcWeekday(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function observedKey(year: number, month: number, day: number): string {
  const weekday = utcWeekday(year, month, day);
  if (weekday === 6) return utcKey(year, month, day - 1);
  if (weekday === 0) return utcKey(year, month, day + 1);
  return utcKey(year, month, day);
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): string {
  const firstWeekday = utcWeekday(year, month, 1);
  const day = 1 + ((weekday - firstWeekday + 7) % 7) + (nth - 1) * 7;
  return utcKey(year, month, day);
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number): string {
  const last = new Date(Date.UTC(year, month, 0));
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return utcKey(year, month, last.getUTCDate() - offset);
}

function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

function goodFridayKey(year: number): string {
  const easter = easterSunday(year);
  const date = new Date(Date.UTC(year, easter.month - 1, easter.day - 2));
  return date.toISOString().slice(0, 10);
}

const SPECIAL_CLOSURES = new Map<string, string>([
  ['2001-09-11', 'September 11 closure'],
  ['2001-09-12', 'September 11 closure'],
  ['2001-09-13', 'September 11 closure'],
  ['2001-09-14', 'September 11 closure'],
  ['2004-06-11', 'National day of mourning (Reagan)'],
  ['2007-01-02', 'National day of mourning (Ford)'],
  ['2012-10-29', 'Hurricane Sandy'],
  ['2012-10-30', 'Hurricane Sandy'],
  ['2018-12-05', 'National day of mourning (G.H.W. Bush)'],
  ['2025-01-09', 'National day of mourning (Carter)'],
]);

const holidayCache = new Map<number, Map<string, string>>();
const tradingDayCache = new Map<string, boolean>();

function holidaysForYear(year: number): Map<string, string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;
  const holidays = new Map<string, string>();
  const add = (key: string, name: string) => {
    // Only include dates that actually occur in the requested calendar year.
    if (key.startsWith(`${year}-`)) holidays.set(key, name);
  };

  add(observedKey(year, 1, 1), "New Year's Day");
  // Jan 1 of year+1 may be observed on Dec 31 of this year.
  add(observedKey(year + 1, 1, 1), "New Year's Day (observed)");
  add(nthWeekdayOfMonth(year, 1, 1, 3), 'Martin Luther King Jr. Day');
  add(nthWeekdayOfMonth(year, 2, 1, 3), "Washington's Birthday");
  add(goodFridayKey(year), 'Good Friday');
  add(lastWeekdayOfMonth(year, 5, 1), 'Memorial Day');
  if (year >= 2022) add(observedKey(year, 6, 19), 'Juneteenth');
  add(observedKey(year, 7, 4), 'Independence Day');
  add(nthWeekdayOfMonth(year, 9, 1, 1), 'Labor Day');
  add(nthWeekdayOfMonth(year, 11, 4, 4), 'Thanksgiving Day');
  add(observedKey(year, 12, 25), 'Christmas Day');

  for (const [key, name] of SPECIAL_CLOSURES) {
    if (key.startsWith(`${year}-`)) holidays.set(key, name);
  }
  holidayCache.set(year, holidays);
  return holidays;
}

function nyDate(ms: number): NyDate {
  const parts = dateFormatter.formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? '';
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  const weekdayText = get('weekday');
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayText);
  return {
    year,
    month,
    day,
    weekday: weekday < 0 ? new Date(Date.UTC(year, month - 1, day)).getUTCDay() : weekday,
    key: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

/** Returns true when the New York calendar date is a regular US equity trading day. */
export function isUsMarketTradingDay(ms: number): boolean {
  const date = nyDate(ms);
  const cached = tradingDayCache.get(date.key);
  if (cached !== undefined) return cached;
  const trading = date.weekday !== 0 && date.weekday !== 6 && !holidaysForYear(date.year).has(date.key);
  tradingDayCache.set(date.key, trading);
  return trading;
}

/** Returns the full-day NYSE/Nasdaq closure name, or null on a trading day. */
export function usMarketHolidayName(ms: number): string | null {
  const date = nyDate(ms);
  if (date.weekday === 0 || date.weekday === 6) return 'Weekend';
  return holidaysForYear(date.year).get(date.key) ?? null;
}

/** Exposed for focused calendar tests. */
export function usMarketDateKey(ms: number): string {
  return nyDate(ms).key;
}
