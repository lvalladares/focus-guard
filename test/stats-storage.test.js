import { describe, it, expect } from 'vitest';
import { createStatsStorage, mergeDayValue } from '../src/lib/stats-storage.js';
import { STATS } from '../src/lib/constants.js';

const NOW = new Date('2026-11-09T12:00:00').getTime();

function makeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      if (keys === null || keys === undefined) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of list) {
        if (key in data) out[key] = data[key];
      }
      return out;
    },
    async set(writes) {
      Object.assign(data, writes);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
  };
}

const key = (day) => `${STATS.DAY_KEY_PREFIX}${day}`;

describe('mergeDayValue', () => {
  it('merges seconds and visits per host', () => {
    const merged = mergeDayValue(
      { 'reddit.com': { s: 100, v: 2 } },
      { 'reddit.com': { s: 50, v: 1 }, 'news.com': { s: 10, v: 1 } },
    );
    expect(merged).toEqual({
      'reddit.com': { s: 150, v: 3 },
      'news.com': { s: 10, v: 1 },
    });
  });

  it('tolerates missing inputs and malformed entries', () => {
    expect(mergeDayValue(null, { 'x.com': { s: 5, v: 1 } })).toEqual({ 'x.com': { s: 5, v: 1 } });
    expect(mergeDayValue({ 'x.com': { s: 5, v: 1 } }, null)).toEqual({ 'x.com': { s: 5, v: 1 } });
    expect(mergeDayValue({ 'x.com': null }, { 'x.com': { s: 1, v: 0 } })).toEqual({ 'x.com': { s: 1, v: 0 } });
  });
});

describe('stats storage', () => {
  it('flushes emissions into per-day keys', async () => {
    const storage = makeStorage();
    const stats = createStatsStorage({ storage, now: () => NOW });
    await stats.flush([
      { hostname: 'reddit.com', visits: 1, chunks: [{ dayKey: '2026-11-09', seconds: 300 }] },
      { hostname: 'old.reddit.com', visits: 2, chunks: [{ dayKey: '2026-11-09', seconds: 120 }, { dayKey: '2026-11-08', seconds: 60 }] },
    ]);
    expect(storage.data[key('2026-11-09')]).toEqual({
      'reddit.com': { s: 300, v: 1 },
      'old.reddit.com': { s: 120, v: 2 },
    });
    expect(storage.data[key('2026-11-08')]).toEqual({ 'old.reddit.com': { s: 60, v: 2 } });
  });

  it('accumulates across multiple flushes', async () => {
    const storage = makeStorage();
    const stats = createStatsStorage({ storage, now: () => NOW });
    await stats.flush([{ hostname: 'a.com', visits: 1, chunks: [{ dayKey: '2026-11-09', seconds: 100 }] }]);
    await stats.flush([{ hostname: 'a.com', visits: 1, chunks: [{ dayKey: '2026-11-09', seconds: 200 }] }]);
    expect(storage.data[key('2026-11-09')]).toEqual({ 'a.com': { s: 300, v: 2 } });
  });

  it('ignores empty flushes', async () => {
    const storage = makeStorage();
    const stats = createStatsStorage({ storage, now: () => NOW });
    await stats.flush([]);
    await stats.flush(null);
    expect(Object.keys(storage.data).filter((k) => k !== STATS.META_KEY)).toEqual([]);
  });

  it('queries only requested day keys', async () => {
    const storage = makeStorage({
      [key('2026-11-08')]: { 'a.com': { s: 10, v: 1 } },
      [key('2026-11-09')]: { 'a.com': { s: 20, v: 2 } },
      [key('2026-11-10')]: { 'a.com': { s: 40, v: 4 } },
    });
    const stats = createStatsStorage({ storage, now: () => NOW });
    const buckets = await stats.queryDayKeys(['2026-11-09', '2026-11-10', '2026-11-11']);
    expect(buckets).toEqual({
      '2026-11-09': { 'a.com': { s: 20, v: 2 } },
      '2026-11-10': { 'a.com': { s: 40, v: 4 } },
    });
  });

  it('queryAll returns every stats day but never meta or other keys', async () => {
    const storage = makeStorage({
      focusConfig: { hello: true },
      [STATS.META_KEY]: { enabled: true },
      [key('2026-11-08')]: { 'a.com': { s: 10, v: 1 } },
    });
    const stats = createStatsStorage({ storage, now: () => NOW });
    const buckets = await stats.queryAll();
    expect(buckets).toEqual({ '2026-11-08': { 'a.com': { s: 10, v: 1 } } });
  });

  it('prunes day keys older than the retention window once per day', async () => {
    const storage = makeStorage({
      [key('2025-01-01')]: { 'old.com': { s: 1, v: 1 } },
      [key('2025-11-02')]: { 'edge.com': { s: 1, v: 1 } },
      [key('2026-11-09')]: { 'fresh.com': { s: 1, v: 1 } },
    });
    const stats = createStatsStorage({ storage, now: () => NOW });
    await stats.flush([{ hostname: 'fresh.com', visits: 1, chunks: [{ dayKey: '2026-11-09', seconds: 5 }] }]);

    expect(storage.data[key('2025-01-01')]).toBeUndefined();
    expect(storage.data[key('2025-11-02')]).toEqual({ 'edge.com': { s: 1, v: 1 } });
    expect(storage.data[key('2026-11-09')]).toEqual({ 'fresh.com': { s: 6, v: 2 } });

    const meta = await stats.getMeta();
    expect(meta.lastPruneDay).toBe('2026-11-09');
    expect(meta.retentionMonths).toBe(12);

    await stats.flush([{ hostname: 'fresh.com', visits: 1, chunks: [{ dayKey: '2026-11-09', seconds: 5 }] }]);
    expect(storage.data[key('2026-11-09')]).toEqual({ 'fresh.com': { s: 11, v: 3 } });
  });

  it('clear removes day data but keeps meta', async () => {
    const storage = makeStorage({
      [key('2026-11-08')]: { 'a.com': { s: 10, v: 1 } },
      [STATS.META_KEY]: { enabled: true, retentionMonths: 12 },
      focusConfig: { keep: true },
    });
    const stats = createStatsStorage({ storage, now: () => NOW });
    await stats.clear();
    expect(storage.data[key('2026-11-08')]).toBeUndefined();
    expect(storage.data[STATS.META_KEY]).toEqual({ enabled: true, retentionMonths: 12 });
    expect(storage.data.focusConfig).toEqual({ keep: true });
  });

  it('serializes concurrent flushes without losing data', async () => {
    const storage = makeStorage();
    const stats = createStatsStorage({ storage, now: () => NOW });
    await Promise.all([
      stats.flush([{ hostname: 'a.com', visits: 1, chunks: [{ dayKey: '2026-11-09', seconds: 100 }] }]),
      stats.flush([{ hostname: 'a.com', visits: 1, chunks: [{ dayKey: '2026-11-09', seconds: 200 }] }]),
      stats.flush([{ hostname: 'a.com', visits: 1, chunks: [{ dayKey: '2026-11-09', seconds: 300 }] }]),
    ]);
    expect(storage.data[key('2026-11-09')]).toEqual({ 'a.com': { s: 600, v: 3 } });
  });
});
