import { describe, it, expect } from 'vitest';
import {
  parseTime,
  formatTime,
  normalizeWindows,
  isWithinSchedule,
  nextScheduleChange,
  scheduleBlockingEnd,
} from '../src/lib/schedule.js';

const SUNDAY = 8;
const MONDAY = 9;
const TUESDAY = 10;
const WEDNESDAY = 11;

function at(day, hours, minutes = 0, seconds = 0, ms = 0) {
  return new Date(2026, 10, day, hours, minutes, seconds, ms);
}

const WEEKDAYS = [1, 2, 3, 4, 5];
const WORK_SCHEDULE = { windows: [{ days: WEEKDAYS, start: '09:00', end: '17:00' }] };

describe('parseTime / formatTime', () => {
  it('parses HH:MM', () => {
    expect(parseTime('09:30')).toEqual({ ok: true, minutes: 570 });
    expect(parseTime('00:00')).toEqual({ ok: true, minutes: 0 });
    expect(parseTime('23:59')).toEqual({ ok: true, minutes: 1439 });
    expect(parseTime('  08:05 ')).toEqual({ ok: true, minutes: 485 });
  });
  it('rejects bad times', () => {
    for (const bad of ['24:00', '12:60', '9:30', '1230', 'ab:cd', '', null]) {
      expect(parseTime(bad).ok).toBe(false);
    }
  });
  it('formats minutes back to HH:MM', () => {
    expect(formatTime(570)).toBe('09:30');
    expect(formatTime(0)).toBe('00:00');
    expect(formatTime(1439)).toBe('23:59');
    expect(formatTime(1440)).toBe('00:00');
  });
});

describe('normalizeWindows', () => {
  it('parses valid windows and flags overnight ones', () => {
    const { windows } = normalizeWindows({ windows: [{ days: [1], start: '09:00', end: '17:00' }, { days: [1, 2], start: '22:00', end: '06:00' }] });
    expect(windows).toEqual([
      { days: [1], start: 540, end: 1020, overnight: false },
      { days: [1, 2], start: 1320, end: 360, overnight: true },
    ]);
  });
  it('drops invalid windows with errors', () => {
    const { windows, errors } = normalizeWindows({ windows: [{ days: [1], start: '25:00', end: '17:00' }, { days: [1], start: '09:00', end: '09:00' }, { days: [], start: '09:00', end: '10:00' }] });
    expect(windows).toEqual([]);
    expect(errors).toHaveLength(3);
  });
  it('handles missing schedule', () => {
    expect(normalizeWindows(null).windows).toEqual([]);
    expect(isWithinSchedule(new Date(), null)).toBe(false);
  });
});

describe('isWithinSchedule', () => {
  it('is active during weekday work hours', () => {
    expect(isWithinSchedule(at(MONDAY, 10), WORK_SCHEDULE)).toBe(true);
    expect(isWithinSchedule(at(WEDNESDAY, 16, 59, 59, 999), WORK_SCHEDULE)).toBe(true);
  });
  it('start is inclusive, end is exclusive', () => {
    expect(isWithinSchedule(at(MONDAY, 9, 0, 0, 0), WORK_SCHEDULE)).toBe(true);
    expect(isWithinSchedule(at(MONDAY, 8, 59, 59, 999), WORK_SCHEDULE)).toBe(false);
    expect(isWithinSchedule(at(MONDAY, 17, 0, 0, 0), WORK_SCHEDULE)).toBe(false);
  });
  it('is inactive on weekends', () => {
    expect(isWithinSchedule(at(SUNDAY, 10), WORK_SCHEDULE)).toBe(false);
  });
  it('supports overnight windows', () => {
    const schedule = { windows: [{ days: [1], start: '22:00', end: '06:00' }] };
    expect(isWithinSchedule(at(MONDAY, 23), schedule)).toBe(true);
    expect(isWithinSchedule(at(TUESDAY, 2), schedule)).toBe(true);
    expect(isWithinSchedule(at(TUESDAY, 5, 59, 59, 999), schedule)).toBe(true);
    expect(isWithinSchedule(at(TUESDAY, 6), schedule)).toBe(false);
    expect(isWithinSchedule(at(MONDAY, 21, 59, 59, 999), schedule)).toBe(false);
    expect(isWithinSchedule(at(WEDNESDAY, 2), schedule)).toBe(false);
  });
  it('supports multiple and overlapping windows', () => {
    const schedule = { windows: [{ days: [1], start: '09:00', end: '12:00' }, { days: [1], start: '11:00', end: '15:00' }] };
    expect(isWithinSchedule(at(MONDAY, 10), schedule)).toBe(true);
    expect(isWithinSchedule(at(MONDAY, 13), schedule)).toBe(true);
    expect(isWithinSchedule(at(MONDAY, 15), schedule)).toBe(false);
    expect(isWithinSchedule(at(MONDAY, 8), schedule)).toBe(false);
  });
});

describe('nextScheduleChange', () => {
  it('returns null for empty schedules', () => {
    expect(nextScheduleChange(at(MONDAY, 10), { windows: [] })).toBeNull();
  });
  it('finds the next start from outside', () => {
    const next = nextScheduleChange(at(MONDAY, 7), WORK_SCHEDULE);
    expect(next).toEqual(at(MONDAY, 9));
  });
  it('finds the next end from inside', () => {
    const next = nextScheduleChange(at(MONDAY, 10), WORK_SCHEDULE);
    expect(next).toEqual(at(MONDAY, 17));
  });
  it('jumps to the next weekday when the week is over', () => {
    const next = nextScheduleChange(at(SUNDAY, 10), WORK_SCHEDULE);
    expect(next.getDay()).toBe(1);
    expect(next.getHours()).toBe(9);
  });
  it('handles overnight window ends', () => {
    const schedule = { windows: [{ days: [1], start: '22:00', end: '06:00' }] };
    expect(nextScheduleChange(at(MONDAY, 23), schedule)).toEqual(at(TUESDAY, 6));
    expect(nextScheduleChange(at(TUESDAY, 7), schedule)).toEqual(at(MONDAY + 7, 22));
  });
});

describe('scheduleBlockingEnd', () => {
  it('returns null when not in schedule', () => {
    expect(scheduleBlockingEnd(at(SUNDAY, 10), WORK_SCHEDULE)).toBeNull();
  });
  it('returns the window end', () => {
    expect(scheduleBlockingEnd(at(MONDAY, 10), WORK_SCHEDULE)).toEqual(at(MONDAY, 17));
  });
  it('merges overlapping windows into a contiguous end', () => {
    const schedule = { windows: [{ days: [1], start: '09:00', end: '12:00' }, { days: [1], start: '11:00', end: '15:00' }] };
    expect(scheduleBlockingEnd(at(MONDAY, 10), schedule)).toEqual(at(MONDAY, 15));
  });
  it('chains adjacent windows', () => {
    const schedule = { windows: [{ days: [1], start: '09:00', end: '12:00' }, { days: [1], start: '12:00', end: '17:00' }] };
    expect(scheduleBlockingEnd(at(MONDAY, 10), schedule)).toEqual(at(MONDAY, 17));
  });
  it('returns the morning end for overnight windows', () => {
    const schedule = { windows: [{ days: [1], start: '22:00', end: '06:00' }] };
    expect(scheduleBlockingEnd(at(MONDAY, 23), schedule)).toEqual(at(TUESDAY, 6));
  });
});
