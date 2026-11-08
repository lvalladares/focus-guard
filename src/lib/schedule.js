export function parseTime(str) {
  if (typeof str === 'number' && Number.isInteger(str) && str >= 0 && str <= 1439) {
    return { ok: true, minutes: str };
  }
  if (typeof str !== 'string') return { ok: false, error: 'Time must be a string' };
  const m = /^(\d{2}):(\d{2})$/.exec(str.trim());
  if (!m) return { ok: false, error: 'Time must use HH:MM 24h format' };
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours < 0 || hours > 23) return { ok: false, error: 'Hours must be 00-23' };
  if (minutes < 0 || minutes > 59) return { ok: false, error: 'Minutes must be 00-59' };
  return { ok: true, minutes: hours * 60 + minutes };
}

export function formatTime(totalMinutes) {
  const m = ((Math.floor(totalMinutes) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function normalizeWindows(schedule) {
  const windows = [];
  const errors = [];
  const list = (schedule && Array.isArray(schedule.windows)) ? schedule.windows : [];
  list.forEach((w, i) => {
    const start = parseTime(w && w.start);
    const end = parseTime(w && w.end);
    if (!start.ok || !end.ok) {
      errors.push({ index: i, error: !start.ok ? start.error : end.error });
      return;
    }
    if (start.minutes === end.minutes) {
      errors.push({ index: i, error: 'Window start and end are the same' });
      return;
    }
    const days = [...new Set((Array.isArray(w.days) ? w.days : []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
    if (days.length === 0) {
      errors.push({ index: i, error: 'Window has no days' });
      return;
    }
    windows.push({ days, start: start.minutes, end: end.minutes, overnight: start.minutes > end.minutes });
  });
  return { windows, errors };
}

function dateParts(date) {
  return { day: date.getDay(), minutes: date.getHours() * 60 + date.getMinutes(), ms: date.getSeconds() * 1000 + date.getMilliseconds() };
}

function windowActiveAt(window, day, minutes) {
  if (window.overnight) {
    if (window.days.includes(day) && minutes >= window.start) return true;
    const prevDay = (day + 6) % 7;
    if (window.days.includes(prevDay) && minutes < window.end) return true;
    return false;
  }
  return window.days.includes(day) && minutes >= window.start && minutes < window.end;
}

export function isWithinSchedule(date, schedule) {
  const { windows } = normalizeWindows(schedule);
  if (windows.length === 0) return false;
  const { day, minutes } = dateParts(date);
  return windows.some((w) => windowActiveAt(w, day, minutes));
}

function dateAt(base, offsetDays, minutesSinceMidnight) {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  d.setHours(Math.floor(minutesSinceMidnight / 60), minutesSinceMidnight % 60, 0, 0);
  return d;
}

function windowEndDate(window, date) {
  const { minutes } = dateParts(date);
  if (!window.overnight) return dateAt(date, 0, window.end);
  if (minutes >= window.start) return dateAt(date, 1, window.end);
  return dateAt(date, 0, window.end);
}

export function activeWindowEnds(date, schedule) {
  const { windows } = normalizeWindows(schedule);
  const { day, minutes } = dateParts(date);
  const ends = [];
  for (const w of windows) {
    if (windowActiveAt(w, day, minutes)) ends.push(windowEndDate(w, date));
  }
  return ends;
}

export function scheduleBlockingEnd(date, schedule) {
  if (!isWithinSchedule(date, schedule)) return null;
  let t = new Date(date.getTime());
  for (let i = 0; i < 500; i += 1) {
    const ends = activeWindowEnds(t, schedule);
    if (ends.length === 0) return t;
    let maxEnd = ends[0];
    for (const e of ends) if (e.getTime() > maxEnd.getTime()) maxEnd = e;
    if (maxEnd.getTime() <= t.getTime()) return t;
    t = maxEnd;
  }
  return t;
}

export function nextScheduleChange(date, schedule) {
  const { windows } = normalizeWindows(schedule);
  if (windows.length === 0) return null;
  const candidates = [];
  for (let offset = 0; offset < 8; offset += 1) {
    const dayDate = new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset, 0, 0, 0, 0);
    const day = dayDate.getDay();
    for (const w of windows) {
      if (!w.days.includes(day)) continue;
      candidates.push(dateAt(dayDate, 0, w.start));
      candidates.push(dateAt(dayDate, w.overnight ? 1 : 0, w.end));
    }
  }
  const nowMs = date.getTime();
  let best = null;
  for (const c of candidates) {
    if (c.getTime() <= nowMs) continue;
    if (!best || c.getTime() < best.getTime()) best = c;
  }
  return best;
}
