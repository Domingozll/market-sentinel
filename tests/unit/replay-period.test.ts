import { describe, expect, it } from 'vitest';
import {
  normalizeReplayPeriod,
  isWithinDailyWindow,
  zonedTimeToUtc,
  replayRangeDays,
} from '../../src/server/replayPeriod';

const now = Date.parse('2026-11-17T00:00:00Z');

describe('custom replay period', () => {
  it('normalizes inclusive dates and an all-day window in the selected timezone', () => {
    const period = normalizeReplayPeriod({
      startDate: '2026-11-10',
      endDate: '2026-11-16',
      timezone: 'Asia/Shanghai',
      allDay: true,
    }, now);
    expect(period.from).toBe(Date.parse('2026-11-09T16:00:00Z'));
    expect(period.to).toBe(Date.parse('2026-11-16T16:00:00Z'));
    expect(period.dailyStartMinute).toBe(0);
    expect(period.dailyEndMinute).toBe(1440);
    expect(period.allDay).toBe(true);
    expect(replayRangeDays(period)).toBe(7);
  });

  it('evaluates a daily window in the configured timezone', () => {
    const period = normalizeReplayPeriod({
      startDate: '2026-11-10',
      endDate: '2026-11-16',
      timezone: 'America/New_York',
      dailyStart: '09:30',
      dailyEnd: '16:00',
    }, now);
    const at = (date: string, time: string) => zonedTimeToUtc(
      Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10)),
      Number(time.slice(0, 2)), Number(time.slice(3, 5)), 'America/New_York',
    );
    expect(isWithinDailyWindow(at('2026-11-10', '09:30'), period)).toBe(true);
    expect(isWithinDailyWindow(at('2026-11-10', '15:59'), period)).toBe(true);
    expect(isWithinDailyWindow(at('2026-11-10', '16:00'), period)).toBe(false);
    expect(isWithinDailyWindow(at('2026-11-10', '09:29'), period)).toBe(false);
  });

  it('supports overnight daily windows', () => {
    const period = normalizeReplayPeriod({
      startDate: '2026-11-10',
      endDate: '2026-11-11',
      timezone: 'UTC',
      dailyStart: '22:00',
      dailyEnd: '06:00',
    }, now);
    const at = (time: string) => Date.parse(`2026-11-10T${time}:00Z`);
    expect(isWithinDailyWindow(at('22:00'), period)).toBe(true);
    expect(isWithinDailyWindow(at('23:30'), period)).toBe(true);
    expect(isWithinDailyWindow(at('05:59'), period)).toBe(true);
    expect(isWithinDailyWindow(at('06:00'), period)).toBe(false);
    expect(isWithinDailyWindow(at('12:00'), period)).toBe(false);
  });

  it('handles DST when deriving the end of the date range', () => {
    const period = normalizeReplayPeriod({
      startDate: '2025-03-08',
      endDate: '2025-03-10',
      timezone: 'America/New_York',
      allDay: true,
    }, Date.parse('2025-03-12T00:00:00Z'));
    expect(period.from).toBe(Date.parse('2025-03-08T05:00:00Z'));
    // Mar 11 00:00 EDT, not Mar 11 04:00Z (which is Mar 11 midnight EST).
    expect(period.to).toBe(Date.parse('2025-03-11T04:00:00Z'));
  });

  it('clamps the range to now and rejects invalid input', () => {
    const period = normalizeReplayPeriod({
      startDate: '2026-11-16',
      endDate: '2026-11-16',
      timezone: 'UTC',
      allDay: true,
    }, Date.parse('2026-11-16T12:00:00Z'));
    expect(period.to).toBe(Date.parse('2026-11-16T12:00:00Z'));

    expect(() => normalizeReplayPeriod({ startDate: '2026-11-16', endDate: '2026-11-15', timezone: 'UTC', allDay: true }, now)).toThrow('结束日期');
    expect(() => normalizeReplayPeriod({ startDate: '2026-11-16', endDate: '2026-11-17', timezone: 'Mars/Base', allDay: true }, now)).toThrow('时区');
    expect(() => normalizeReplayPeriod({ startDate: '2026-11-16', endDate: '2026-11-17', timezone: 'UTC', dailyStart: '10:00', dailyEnd: '10:00' }, now)).toThrow('不能相同');
  });
});
