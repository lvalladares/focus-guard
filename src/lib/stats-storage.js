import { STATS } from './constants.js';
import { dateKey, monthsAgo } from './dates.js';

export function mergeDayValue(existing, additions) {
  const merged = {};
  for (const [hostname, entry] of Object.entries(existing || {})) {
    merged[hostname] = { s: Number(entry && entry.s) || 0, v: Number(entry && entry.v) || 0 };
  }
  for (const [hostname, entry] of Object.entries(additions || {})) {
    const current = merged[hostname] || { s: 0, v: 0 };
    current.s += Number(entry && entry.s) || 0;
    current.v += Number(entry && entry.v) || 0;
    merged[hostname] = current;
  }
  return merged;
}

function emissionsToDayAdditions(emissions) {
  const byDay = {};
  for (const emission of emissions || []) {
    if (!emission || !emission.hostname) continue;
    for (const chunk of emission.chunks || []) {
      byDay[chunk.dayKey] = byDay[chunk.dayKey] || {};
      const host = byDay[chunk.dayKey][emission.hostname] || { s: 0, v: 0 };
      host.s += chunk.seconds;
      host.v += emission.visits;
      byDay[chunk.dayKey][emission.hostname] = host;
    }
  }
  return byDay;
}

export function createStatsStorage({ storage, now = () => Date.now() }) {
  let queue = Promise.resolve();

  function serialize(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  function dayKey(k) {
    return `${STATS.DAY_KEY_PREFIX}${k}`;
  }

  async function getMeta() {
    const store = await storage.get([STATS.META_KEY]);
    return store[STATS.META_KEY] || { enabled: true, retentionMonths: STATS.DEFAULT_RETENTION_MONTHS };
  }

  async function setMeta(meta) {
    await storage.set({ [STATS.META_KEY]: meta });
  }

  async function flush(emissions) {
    return serialize(async () => {
      const byDay = emissionsToDayAdditions(emissions);
      const keys = Object.keys(byDay);
      if (keys.length === 0) return;
      const store = await storage.get(keys.map(dayKey));
      const writes = {};
      for (const key of keys) {
        writes[dayKey(key)] = mergeDayValue(store[dayKey(key)], byDay[key]);
      }
      await storage.set(writes);
      await maybePrune();
    });
  }

  async function maybePrune() {
    const meta = await getMeta();
    const today = dateKey(new Date(now()));
    if (meta.lastPruneDay === today) return;
    meta.lastPruneDay = today;
    const cutoff = dateKey(monthsAgo(new Date(now()), meta.retentionMonths));
    const everything = await storage.get(null);
    const staleKeys = Object.keys(everything)
      .filter((key) => key.startsWith(STATS.DAY_KEY_PREFIX))
      .filter((key) => {
        const day = key.slice(STATS.DAY_KEY_PREFIX.length);
        return day !== 'meta' && day < cutoff;
      });
    if (staleKeys.length > 0) await storage.remove(staleKeys);
    await setMeta(meta);
  }

  async function queryDayKeys(keys) {
    const store = await storage.get(keys.map(dayKey));
    const buckets = {};
    for (const key of keys) {
      if (store[dayKey(key)]) buckets[key] = store[dayKey(key)];
    }
    return buckets;
  }

  async function queryAll() {
    const everything = await storage.get(null);
    const buckets = {};
    for (const [key, value] of Object.entries(everything)) {
      if (key.startsWith(STATS.DAY_KEY_PREFIX)) {
        const day = key.slice(STATS.DAY_KEY_PREFIX.length);
        if (day !== 'meta') buckets[day] = value;
      }
    }
    return buckets;
  }

  async function clear() {
    const everything = await storage.get(null);
    const keys = Object.keys(everything).filter((key) => key.startsWith(STATS.DAY_KEY_PREFIX) && key !== STATS.META_KEY);
    if (keys.length > 0) await storage.remove(keys);
  }

  return { flush, queryDayKeys, queryAll, clear, getMeta, setMeta, maybePrune };
}
