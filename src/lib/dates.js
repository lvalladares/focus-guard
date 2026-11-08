export function dateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function parseDayKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

export function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

export function addDays(date, count) {
  const d = startOfDay(date);
  d.setDate(d.getDate() + count);
  return d;
}

export function weekStart(date) {
  const day = date.getDay();
  const diff = day === 0 ? 6 : day - 1;
  return addDays(date, -diff);
}

export function monthStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function monthsAgo(date, count) {
  return new Date(date.getFullYear(), date.getMonth() - count, 1);
}

export function periodStart(period, now = new Date()) {
  if (period === 'today') return startOfDay(now);
  if (period === 'week') return weekStart(now);
  if (period === 'month') return monthStart(now);
  return null;
}

export function dayKeysBetween(fromDate, toDate) {
  const keys = [];
  let cursor = startOfDay(fromDate);
  const end = startOfDay(toDate);
  while (cursor.getTime() <= end.getTime()) {
    keys.push(dateKey(cursor));
    cursor = addDays(cursor, 1);
  }
  return keys;
}

export function nextLocalMidnight(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
}

export function splitSegmentByDay(startMs, endMs) {
  const chunks = [];
  if (endMs <= startMs) return chunks;
  let cursor = startMs;
  while (cursor < endMs) {
    const midnight = nextLocalMidnight(cursor);
    const cut = Math.min(endMs, midnight);
    if (cut > cursor) {
      chunks.push({
        dayKey: dateKey(new Date(cursor)),
        seconds: (cut - cursor) / 1000,
      });
    }
    cursor = cut;
  }
  return chunks;
}
