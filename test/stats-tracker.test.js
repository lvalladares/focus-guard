import { describe, it, expect } from 'vitest';
import { createSegmentTracker } from '../src/lib/stats-tracker.js';

const T0 = new Date('2026-11-09T10:00:00').getTime();
const MIN = 60 * 1000;

function sumSeconds(emissions, dayKey) {
  let total = 0;
  for (const e of emissions) {
    for (const c of e.chunks) {
      if (!dayKey || c.dayKey === dayKey) total += c.seconds;
    }
  }
  return total;
}

function totalVisits(emissions) {
  return emissions.reduce((sum, e) => sum + e.visits, 0);
}

describe('segment tracker', () => {
  it('opens a segment on focus and closes it on the next focus', () => {
    const tracker = createSegmentTracker();
    expect(tracker.handleFocus({ hostname: 'reddit.com', tabId: 1, windowId: 1, time: T0 })).toEqual([]);
    const closed = tracker.handleFocus({ hostname: 'news.com', tabId: 2, windowId: 1, time: T0 + 10 * MIN });
    expect(closed).toHaveLength(1);
    expect(closed[0].hostname).toBe('reddit.com');
    expect(closed[0].visits).toBe(1);
    expect(sumSeconds(closed)).toBe(10 * 60);
  });

  it('merges focus switches between the same hostname without a new visit', () => {
    const tracker = createSegmentTracker();
    tracker.handleFocus({ hostname: 'reddit.com', tabId: 1, windowId: 1, time: T0 });
    const closed = tracker.handleFocus({ hostname: 'reddit.com', tabId: 7, windowId: 2, time: T0 + 5 * MIN });
    expect(closed).toEqual([]);
    const end = tracker.handleBlur(T0 + 12 * MIN);
    expect(end).toHaveLength(1);
    expect(end[0].visits).toBe(1);
    expect(sumSeconds(end)).toBe(12 * 60);
    expect(tracker.getCurrent()).toBeNull();
  });

  it('closes on blur and counts a new visit when returning', () => {
    const tracker = createSegmentTracker();
    tracker.handleFocus({ hostname: 'reddit.com', tabId: 1, windowId: 1, time: T0 });
    const first = tracker.handleBlur(T0 + 3 * MIN);
    expect(first).toHaveLength(1);
    tracker.handleFocus({ hostname: 'reddit.com', tabId: 1, windowId: 1, time: T0 + 30 * MIN });
    const second = tracker.handleBlur(T0 + 35 * MIN);
    expect(totalVisits(second)).toBe(1);
    expect(sumSeconds(second)).toBe(5 * 60);
    expect(totalVisits(first)).toBe(1);
  });

  it('treats non-http focus as a close (extension pages stop the clock)', () => {
    const tracker = createSegmentTracker();
    tracker.handleFocus({ hostname: 'reddit.com', tabId: 1, windowId: 1, time: T0 });
    const closed = tracker.handleFocus({ hostname: null, tabId: 1, windowId: 1, time: T0 + 4 * MIN });
    expect(closed).toHaveLength(1);
    expect(tracker.getCurrent()).toBeNull();
    expect(tracker.handleFocus({ hostname: null, tabId: 2, windowId: 1, time: T0 + 5 * MIN })).toEqual([]);
  });

  it('only closes on tab removal when it is the tracked tab', () => {
    const tracker = createSegmentTracker();
    tracker.handleFocus({ hostname: 'reddit.com', tabId: 3, windowId: 1, time: T0 });
    expect(tracker.handleTabRemoved(99, T0 + 1 * MIN)).toEqual([]);
    expect(tracker.getCurrent()).not.toBeNull();
    const closed = tracker.handleTabRemoved(3, T0 + 6 * MIN);
    expect(closed).toHaveLength(1);
    expect(sumSeconds(closed)).toBe(6 * 60);
  });

  it('checkpoints partial time and keeps the segment open without extra visits', () => {
    const tracker = createSegmentTracker();
    tracker.handleFocus({ hostname: 'youtube.com', tabId: 1, windowId: 1, time: T0 });
    const cp1 = tracker.checkpoint(T0 + MIN);
    expect(cp1).toHaveLength(1);
    expect(cp1[0].visits).toBe(1);
    expect(sumSeconds(cp1)).toBe(60);
    expect(tracker.getCurrent()).not.toBeNull();
    const cp2 = tracker.checkpoint(T0 + 2 * MIN);
    expect(cp2[0].visits).toBe(0);
    expect(sumSeconds(cp2)).toBe(60);
    const closed = tracker.handleBlur(T0 + 3 * MIN);
    expect(closed[0].visits).toBe(0);
    expect(sumSeconds(closed)).toBe(60);
  });

  it('emits the pending visit exactly once even with zero elapsed time', () => {
    const tracker = createSegmentTracker();
    tracker.handleFocus({ hostname: 'x.com', tabId: 1, windowId: 1, time: T0 });
    expect(tracker.checkpoint(T0)).toEqual([{ hostname: 'x.com', visits: 1, chunks: [] }]);
    expect(tracker.handleBlur(T0)).toEqual([]);
    expect(tracker.getCurrent()).toBeNull();
  });

  it('still counts the visit for an instantly closed segment', () => {
    const tracker = createSegmentTracker();
    tracker.handleFocus({ hostname: 'x.com', tabId: 1, windowId: 1, time: T0 });
    const closed = tracker.handleBlur(T0);
    expect(closed).toEqual([{ hostname: 'x.com', visits: 1, chunks: [] }]);
    expect(tracker.getCurrent()).toBeNull();
  });

  it('splits long segments across midnight', () => {
    const start = new Date('2026-11-09T23:50:00').getTime();
    const tracker = createSegmentTracker();
    tracker.handleFocus({ hostname: 'reddit.com', tabId: 1, windowId: 1, time: start });
    const closed = tracker.handleBlur(start + 20 * MIN);
    expect(closed[0].chunks).toEqual([
      { dayKey: '2026-11-09', seconds: 600 },
      { dayKey: '2026-11-10', seconds: 600 },
    ]);
  });

  it('restores state from a previous worker life', () => {
    const tracker = createSegmentTracker();
    tracker.handleFocus({ hostname: 'reddit.com', tabId: 1, windowId: 1, time: T0 });
    const snapshot = tracker.getCurrent();

    const revived = createSegmentTracker();
    revived.restoreCurrent(snapshot);
    expect(revived.handleFocus({ hostname: 'reddit.com', tabId: 1, windowId: 1, time: T0 + 5 * MIN })).toEqual([]);
    const closed = revived.handleBlur(T0 + 8 * MIN);
    expect(totalVisits(closed)).toBe(1);
    expect(sumSeconds(closed)).toBe(8 * 60);
  });

  it('restores checkpointed state without double counting', () => {
    const tracker = createSegmentTracker();
    tracker.handleFocus({ hostname: 'a.com', tabId: 1, windowId: 1, time: T0 });
    const cp = tracker.checkpoint(T0 + 4 * MIN);
    expect(sumSeconds(cp)).toBe(240);
    const snapshot = tracker.getCurrent();

    const revived = createSegmentTracker();
    revived.restoreCurrent(snapshot);
    const closed = revived.handleBlur(T0 + 6 * MIN);
    expect(sumSeconds(closed)).toBe(120);
    expect(totalVisits(closed)).toBe(0);
  });

  it('ignore restore of invalid segments', () => {
    const tracker = createSegmentTracker();
    tracker.restoreCurrent(null);
    tracker.restoreCurrent('nonsense');
    expect(tracker.getCurrent()).toBeNull();
  });
});
