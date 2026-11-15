import { describe, it, expect } from 'vitest';
import { planSweep, planRestore, targetOfBlockedPage } from '../src/lib/tab-sweep.js';
import { activateBlockSnooze, emptyBlockState } from '../src/lib/sessions.js';

const NOW = new Date('2026-11-09T10:00:00').getTime();
const MIN = 60 * 1000;

const BLOCKED_PAGE = 'chrome-extension://abc/src/pages/blocked/blocked.html';
const GATE_PAGE = 'chrome-extension://abc/src/pages/gate/gate.html';

const blocked = (url) => `${BLOCKED_PAGE}#${encodeURIComponent(url)}`;
const redirectFor = (url) => blocked(url);

function makeBlock(overrides = {}) {
  return {
    id: 'b1',
    name: 'Block 1',
    enabled: true,
    persistent: false,
    sites: [
      { id: 's1', domain: 'reddit.com', includeBaseHost: true, includeAllSubdomains: false, subdomains: [], whitelist: [] },
    ],
    schedule: { alwaysActive: false, windows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }] },
    timeLimit: { enabled: false, minutes: 20, periodHours: 8 },
    snooze: { enabled: false, durationMinutes: 5, maxCount: 1, periodHours: 4 },
    ...overrides,
  };
}

function makeConfig(blocks, extra = {}) {
  return {
    schemaVersion: 3,
    master: { enabled: false },
    antiUninstall: { enabled: false },
    blocks,
    ...extra,
  };
}

const runtime = (overrides = {}) => ({ override: null, ...overrides });

describe('planSweep', () => {
  it('pulls already-open tabs of blocked sites to blocked.html', () => {
    const actions = planSweep([
      { id: 1, url: 'https://www.reddit.com/r/all' },
      { id: 2, url: 'http://reddit.com/' },
      { id: 3, url: 'https://example.com/' },
    ], { config: makeConfig([makeBlock()]), runtime: runtime(), blockStates: {}, now: NOW, redirectFor });
    expect(actions).toEqual([
      { tabId: 1, url: blocked('https://www.reddit.com/r/all') },
      { tabId: 2, url: blocked('http://reddit.com/') },
    ]);
  });

  it('pulls chrome://extensions tabs when anti-uninstall protection is active', () => {
    const cfg = makeConfig([makeBlock({ persistent: true })], { antiUninstall: { enabled: true } });
    const actions = planSweep(
      [{ id: 9, url: 'chrome://extensions/' }],
      { config: cfg, runtime: runtime(), blockStates: {}, now: NOW, redirectFor },
    );
    expect(actions).toEqual([{ tabId: 9, url: blocked('chrome://extensions/') }]);
  });

  it('leaves allowed tabs alone (whitelisted, snoozed, budget)', () => {
    const block = makeBlock({
      sites: [{ id: 's1', domain: 'reddit.com', includeBaseHost: true, includeAllSubdomains: false, subdomains: [], whitelist: ['/r/learn*'] }],
      snooze: { enabled: true, durationMinutes: 5, maxCount: 1, periodHours: 4 },
    });
    const { state } = activateBlockSnooze(block, emptyBlockState(), NOW);
    const actions = planSweep([
      { id: 1, url: 'https://www.reddit.com/r/learn' },
      { id: 2, url: 'https://www.reddit.com/r/all' },
    ], { config: makeConfig([block]), runtime: runtime(), blockStates: { b1: state }, now: NOW + MIN, redirectFor });
    expect(actions).toEqual([]);
  });
});

describe('targetOfBlockedPage & planRestore', () => {
  it('extracts target URL from blocked page', () => {
    const target = 'https://www.reddit.com/r/all?x=1';
    expect(targetOfBlockedPage(blocked(target), { blockedPageUrl: BLOCKED_PAGE, gatePageUrl: GATE_PAGE })).toBe(target);
  });

  it('restores parked tabs when snooze starts or override activates', () => {
    const block = makeBlock({ snooze: { enabled: true, durationMinutes: 5, maxCount: 1, periodHours: 4 } });
    const { state } = activateBlockSnooze(block, emptyBlockState(), NOW);
    const actions = planRestore([
      { id: 1, url: blocked('https://www.reddit.com/r/all') },
    ], {
      config: makeConfig([block]),
      runtime: runtime(),
      blockStates: { b1: state },
      now: NOW + MIN,
      blockedPageUrl: BLOCKED_PAGE,
      gatePageUrl: GATE_PAGE,
    });
    expect(actions).toEqual([{ tabId: 1, url: 'https://www.reddit.com/r/all' }]);
  });
});
