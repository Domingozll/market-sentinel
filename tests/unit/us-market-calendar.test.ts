import { describe, expect, it } from 'vitest';
import {
  isUsMarketTradingDay,
  usMarketDateKey,
  usMarketHolidayName,
} from '../../src/server/usMarketCalendar';

// 17:00 UTC is 12:00/13:00 in New York depending on DST, safely inside the date.
const atNoonEt = (date: string): number => Date.parse(`${date}T17:00:00Z`);

describe('US equity market calendar', () => {
  it('detects weekends and regular weekdays', () => {
    expect(usMarketDateKey(atNoonEt('2025-01-04'))).toBe('2025-01-04');
    expect(isUsMarketTradingDay(atNoonEt('2025-01-04'))).toBe(false);
    expect(usMarketHolidayName(atNoonEt('2025-01-04'))).toBe('Weekend');
    expect(isUsMarketTradingDay(atNoonEt('2025-01-06'))).toBe(true);
    expect(usMarketHolidayName(atNoonEt('2025-01-06'))).toBeNull();
  });

  it('covers the regular NYSE holiday calendar', () => {
    const closures = [
      '2025-01-01', // New Year
      '2025-01-20', // MLK
      '2025-02-17', // Washington's Birthday
      '2025-04-18', // Good Friday
      '2025-05-26', // Memorial Day
      '2025-06-19', // Juneteenth
      '2025-07-04', // Independence Day
      '2025-09-01', // Labor Day
      '2025-11-27', // Thanksgiving
      '2025-12-25', // Christmas
    ];
    for (const date of closures) {
      expect(isUsMarketTradingDay(atNoonEt(date)), date).toBe(false);
      expect(usMarketHolidayName(atNoonEt(date)), date).not.toBeNull();
    }
  });

  it('applies observed weekend holidays', () => {
    expect(isUsMarketTradingDay(atNoonEt('2021-07-05'))).toBe(false); // Independence Day (Sunday)
    expect(isUsMarketTradingDay(atNoonEt('2021-12-24'))).toBe(false); // Christmas (Saturday)
    expect(isUsMarketTradingDay(atNoonEt('2021-12-31'))).toBe(false); // New Year 2022 (Saturday)
    expect(isUsMarketTradingDay(atNoonEt('2026-07-03'))).toBe(false); // Independence Day 2026 (Saturday)
    expect(isUsMarketTradingDay(atNoonEt('2022-06-20'))).toBe(false); // Juneteenth observed
  });

  it('does not filter early-close sessions or the pre-2022 Juneteenth date', () => {
    expect(isUsMarketTradingDay(atNoonEt('2025-07-03'))).toBe(true); // early close
    expect(isUsMarketTradingDay(atNoonEt('2025-11-28'))).toBe(true); // early close
    expect(isUsMarketTradingDay(atNoonEt('2021-06-18'))).toBe(true); // before NYSE Juneteenth closure
  });

  it('handles unscheduled historical closures', () => {
    expect(isUsMarketTradingDay(atNoonEt('2025-01-09'))).toBe(false); // Carter mourning
    expect(usMarketHolidayName(atNoonEt('2025-01-09'))).toContain('Carter');
    expect(isUsMarketTradingDay(atNoonEt('2012-10-30'))).toBe(false); // Hurricane Sandy
  });
});
