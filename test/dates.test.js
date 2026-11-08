import { describe, it, expect } from 'vitest';
import {
  dateKey,
  parseDayKey,
  weekStart,
  monthStart,
  monthsAgo,
  periodStart,
  dayKeysBetween,
  nextLocalMidnight,
  splitSegmentByDay,
} from '../src/lib/dates.js';

const d = (y, m, day, h = 0, min = 0, s = 0, ms = 0) => new Date(y, m - 1, day, h, min, s, ms);

describe('dateKey / parseDayKey', () => {
  it('formats local dates as YYYY-MM-DD', () => {
    expect(dateKey(d(2026, 11, 8))).toBe('2026-11-08');
    expect(dateKey(d(2026, 1, 5))).toBe('2026-01-05');
  });

  it('round-trips', () => {
    const date = d(2026, 11, 8);
    expect(parseDayKey(dateKey(date)).getTime()).toBe(date.getTime());
    expect(parseDayKey('not-a-key')).toBeNull();
    expect(parseDayKey('2026-13-40')).toBeNull();
  });
});

describe('weekStart (Monday)', () => {
  it('returns Monday for every weekday', () => {
    expect(weekStart(d(2026, 11, 9)).getDay()).toBe(1);
    expect(weekStart(d(2026, 11, 9)).getDate()).toBe(9);
    expect(weekStart(d(2026, 11, 11)).getDate()).toBe(9);
    expect(weekStart(d(2026, 11, 13)).getDate()).toBe(9);
    expect(weekStart(d(2026, 11, 14)).getDate()).toBe(9);
  });

  it('maps Sunday back to the previous Monday', () => {
    const monday = weekStart(d(2026, 11, 15));
    expect(monday.getDay()).toBe(1);
    expect(monday.getDate()).toBe(9);
  });
});

describe('monthStart / monthsAgo', () => {
  it('computes month boundaries', () => {
    const start = monthStart(d(2026, 11, 15));
    expect(start.getMonth()).toBe(10);
    expect(start.getDate()).toBe(1);
  });

  it('handles year rollover when subtracting months', () => {
    const past = monthsAgo(d(2026, 1, 15), 2);
    expect(past.getFullYear()).toBe(2025);
    expect(past.getMonth()).toBe(10);
  });
});

describe('periodStart', () => {
  it('resolves each period', () => {
    const now = d(2026, 11, 11, 15, 30);
    expect(periodStart('today', now).getDate()).toBe(11);
    expect(periodStart('today', now).getHours()).toBe(0);
    expect(periodStart('week', now).getDate()).toBe(9);
    expect(periodStart('month', now).getDate()).toBe(1);
    expect(periodStart('all', now)).toBeNull();
  });
});

describe('dayKeysBetween', () => {
  it('enumerates inclusive day keys', () => {
    expect(dayKeysBetween(d(2026, 11, 8), d(2026, 11, 8))).toEqual(['2026-11-08']);
    expect(dayKeysBetween(d(2026, 11, 8), d(2026, 11, 11))).toEqual([
      '2026-11-08',
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
    ]);
  });

  it('returns empty for inverted ranges', () => {
    expect(dayKeysBetween(d(2026, 11, 9), d(2026, 11, 8))).toEqual([]);
  });
});

describe('splitSegmentByDay', () => {
  it('keeps same-day segments whole', () => {
    const start = d(2026, 11, 8, 10, 0).getTime();
    const end = d(2026, 11, 8, 11, 30).getTime();
    expect(splitSegmentByDay(start, end)).toEqual([
      { dayKey: '2026-11-08', seconds: 5400 },
    ]);
  });

  it('splits segments crossing midnight', () => {
    const start = d(2026, 11, 8, 23, 50).getTime();
    const end = d(2026, 11, 9, 0, 10).getTime();
    expect(splitSegmentByDay(start, end)).toEqual([
      { dayKey: '2026-11-08', seconds: 600 },
      { dayKey: '2026-11-09', seconds: 600 },
    ]);
  });

  it('splits multi-day segments across each midnight', () => {
    const start = d(2026, 11, 8, 12, 0).getTime();
    const end = d(2026, 11, 10, 12, 0).getTime();
    const chunks = splitSegmentByDay(start, end);
    expect(chunks).toEqual([
      { dayKey: '2026-11-08', seconds: 12 * 3600 },
      { dayKey: '2026-11-09', seconds: 24 * 3600 },
      { dayKey: '2026-11-10', seconds: 12 * 3600 },
    ]);
  });

  it('handles zero and inverted ranges', () => {
    const t = d(2026, 11, 8, 10, 0).getTime();
    expect(splitSegmentByDay(t, t)).toEqual([]);
    expect(splitSegmentByDay(t, t - 1)).toEqual([]);
  });

  it('nextLocalMidnight lands on the following midnight', () => {
    const t = d(2026, 11, 8, 0, 0).getTime();
    const next = nextLocalMidnight(t);
    expect(next - t).toBe(24 * 3600 * 1000);
    expect(nextLocalMidnight(d(2026, 11, 8, 23, 59).getTime())).toBe(d(2026, 11, 9, 0, 0).getTime());
  });
});
