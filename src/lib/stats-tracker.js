import { splitSegmentByDay } from './dates.js';

export function createSegmentTracker() {
  let current = null;
  let pendingVisit = false;

  function emission(endTime, { keepOpen, advanceStart } = {}) {
    if (!current) return [];
    const elapsed = Math.max(0, endTime - current.start);
    const chunks = elapsed > 0 ? splitSegmentByDay(current.start, endTime) : [];
    const emissions = [];
    if (chunks.length > 0 || pendingVisit) {
      emissions.push({ hostname: current.hostname, visits: pendingVisit ? 1 : 0, chunks });
    }
    pendingVisit = false;
    if (advanceStart && elapsed > 0) {
      current.start = endTime;
    }
    if (!keepOpen) {
      current = null;
    }
    return emissions;
  }

  return {
    restoreCurrent(segment) {
      if (segment && typeof segment.hostname === 'string' && typeof segment.start === 'number') {
        current = {
          hostname: segment.hostname,
          tabId: segment.tabId ?? null,
          windowId: segment.windowId ?? null,
          start: segment.start,
        };
        pendingVisit = Boolean(segment.pendingVisit);
      }
    },

    getCurrent() {
      return current ? { ...current, pendingVisit } : null;
    },

    handleFocus({ hostname, tabId, windowId, time }) {
      if (current && hostname && current.hostname === hostname) {
        current.tabId = tabId;
        current.windowId = windowId;
        return [];
      }
      const closed = emission(time);
      if (hostname) {
        current = { hostname, tabId, windowId, start: time };
        pendingVisit = true;
      }
      return closed;
    },

    handleBlur(time) {
      return emission(time);
    },

    handleTabRemoved(tabId, time) {
      if (!current || current.tabId !== tabId) return [];
      return emission(time);
    },

    checkpoint(time) {
      if (!current) return [];
      return emission(time, { keepOpen: true, advanceStart: true });
    },
  };
}
