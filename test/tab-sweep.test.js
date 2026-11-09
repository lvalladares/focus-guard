import { describe, it, expect } from 'vitest';
import { planSweep, planRestore, targetOfBlockedPage } from '../src/lib/tab-sweep.js';
import { startSession } from '../src/lib/sessions.js';

const NOW = new Date('2026-11-09T10:00:00').getTime(); // Monday, inside the focus window
const MIN = 60 * 1000;

const BLOCKED_PAGE = 'chrome-extension://abc/src/pages/blocked/blocked.html';
const GATE_PAGE = 'chrome-extension://abc/src/pages/gate/gate.html';

const blocked = (url) => `${BLOCKED_PAGE}#${encodeURIComponent(url)}`;
const gate = (url) => `${GATE_PAGE}#${encodeURIComponent(url)}`;
const redirectFor = (url, verdict) => (verdict === 'gate' ? gate(url) : blocked(url));

function config(groups, extra = {}) {
  return {
    master: { enabled: false },
    schedule: { windows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }] },
    groups,
    ...extra,
  };
}

function group(overrides = {}) {
  return {
    id: 'g1',
    domain: 'reddit.com',
    includeBaseHost: true,
    includeAllSubdomains: false,
    subdomains: [],
    whitelist: [],
    level: 'total',
    ...overrides,
  };
}

const runtime = (overrides = {}) => ({ sessions: {}, cooldowns: {}, override: null, ...overrides });

const sweepDeps = (cfg, rt) => ({ config: cfg, runtime: rt, now: NOW, redirectFor });
const restoreDeps = (cfg, rt) => ({
  config: cfg,
  runtime: rt,
  now: NOW,
  blockedPageUrl: BLOCKED_PAGE,
  gatePageUrl: GATE_PAGE,
});

describe('planSweep', () => {
  it('pulls already-open tabs of blocked groups to the blocked page', () => {
    const actions = planSweep([
      { id: 1, url: 'https://www.reddit.com/r/all' },
      { id: 2, url: 'http://reddit.com/' },
      { id: 3, url: 'https://example.com/' },
    ], sweepDeps(config([group()]), runtime()));
    expect(actions).toEqual([
      { tabId: 1, url: blocked('https://www.reddit.com/r/all') },
      { tabId: 2, url: blocked('http://reddit.com/') },
    ]);
  });

  it('sends gated tabs to the gate page and cooldown tabs to the blocked page', () => {
    const gated = planSweep(
      [{ id: 1, url: 'https://www.reddit.com/r/all' }],
      sweepDeps(config([group({ level: 'partial' })]), runtime()),
    );
    expect(gated).toEqual([{ tabId: 1, url: gate('https://www.reddit.com/r/all') }]);

    const cooled = planSweep(
      [{ id: 2, url: 'https://www.reddit.com/r/all' }],
      sweepDeps(config([group({ level: 'partial' })]), runtime({ cooldowns: { g1: { startedAt: NOW - MIN, until: NOW + 5 * MIN } } })),
    );
    expect(cooled).toEqual([{ tabId: 2, url: blocked('https://www.reddit.com/r/all') }]);
  });

  it('leaves tabs alone when their verdict allows them', () => {
    const cfg = config([group({ level: 'partial', whitelist: ['/r/learn*'] })]);
    const rt = runtime({ sessions: { g1: startSession({ minutes: 20, now: NOW }) } });
    const actions = planSweep([
      { id: 1, url: 'https://www.reddit.com/r/learn' }, // whitelisted path
      { id: 2, url: 'https://www.reddit.com/r/all' }, // dose running
      { id: 3, url: 'chrome-extension://abc/settings.html' }, // not a site
      { id: 4, url: 'ftp://reddit.com/' }, // not http(s)
    ], sweepDeps(cfg, rt));
    expect(actions).toEqual([]);
  });

  it('skips tabs without an id or url', () => {
    const actions = planSweep(
      [{ url: 'https://reddit.com/' }, { id: 5 }, null, { id: 6, url: '' }],
      sweepDeps(config([group()]), runtime()),
    );
    expect(actions).toEqual([]);
  });
});

describe('targetOfBlockedPage', () => {
  it('extracts the original URL from blocked/gate page tabs', () => {
    const target = 'https://www.reddit.com/r/all?x=1';
    expect(targetOfBlockedPage(blocked(target), restoreDeps(config([]), runtime()))).toBe(target);
    expect(targetOfBlockedPage(gate(target), restoreDeps(config([]), runtime()))).toBe(target);
  });

  it('returns null for anything that is not a parked target', () => {
    const deps = restoreDeps(config([]), runtime());
    expect(targetOfBlockedPage(BLOCKED_PAGE, deps)).toBeNull();
    expect(targetOfBlockedPage(`${BLOCKED_PAGE}#not-a-url`, deps)).toBeNull();
    expect(targetOfBlockedPage('https://reddit.com/', deps)).toBeNull();
    expect(targetOfBlockedPage(undefined, deps)).toBeNull();
  });
});

describe('planRestore', () => {
  it('brings parked tabs back when blocking is globally off', () => {
    const rt = runtime({ override: { until: NOW + 60 * MIN } });
    const actions = planRestore([
      { id: 1, url: blocked('https://www.reddit.com/r/all') },
      { id: 2, url: gate('https://www.reddit.com/r/all') },
      { id: 3, url: 'https://example.com/' },
    ], restoreDeps(config([group()]), rt));
    expect(actions).toEqual([
      { tabId: 1, url: 'https://www.reddit.com/r/all' },
      { tabId: 2, url: 'https://www.reddit.com/r/all' },
    ]);
  });

  it('brings parked tabs back while their dose runs, but leaves other groups parked', () => {
    const cfg = config([group({ level: 'partial' }), group({ id: 'g2', domain: 'news.com' })]);
    const rt = runtime({ sessions: { g1: startSession({ minutes: 20, now: NOW }) } });
    const actions = planRestore([
      { id: 1, url: blocked('https://www.reddit.com/r/all') },
      { id: 2, url: blocked('https://news.com/x') },
    ], restoreDeps(cfg, rt));
    expect(actions).toEqual([{ tabId: 1, url: 'https://www.reddit.com/r/all' }]);
  });

  it('restores whitelisted and removed groups, not just global off', () => {
    const cfg = config([group({ whitelist: ['/r/learn*'] })]);
    const whitelisted = planRestore(
      [{ id: 1, url: blocked('https://www.reddit.com/r/learn') }],
      restoreDeps(cfg, runtime()),
    );
    expect(whitelisted).toEqual([{ tabId: 1, url: 'https://www.reddit.com/r/learn' }]);

    const removed = planRestore(
      [{ id: 2, url: blocked('https://news.com/x') }],
      restoreDeps(config([group()]), runtime()),
    );
    expect(removed).toEqual([{ tabId: 2, url: 'https://news.com/x' }]);
  });

  it('leaves parked tabs alone while their target is still blocked or gated', () => {
    const cfg = config([group(), group({ id: 'g2', domain: 'news.com', level: 'partial' })]);
    const actions = planRestore([
      { id: 1, url: blocked('https://www.reddit.com/r/all') }, // still blocked
      { id: 2, url: blocked('https://news.com/x') }, // gated: cooldown over, no dose yet
    ], restoreDeps(cfg, runtime()));
    expect(actions).toEqual([]);
  });

  it('does not race the gate page that is starting its own dose', () => {
    const cfg = config([group({ level: 'partial' })]);
    const rt = runtime({ sessions: { g1: startSession({ minutes: 20, now: NOW }) } });
    const actions = planRestore([
      { id: 1, url: gate('https://www.reddit.com/r/all') }, // gate navigates itself
      { id: 2, url: blocked('https://www.reddit.com/r/all') }, // parked tab comes back
    ], restoreDeps(cfg, rt));
    expect(actions).toEqual([{ tabId: 2, url: 'https://www.reddit.com/r/all' }]);
  });

  it('skips tabs without an id, url or target', () => {
    const actions = planRestore(
      [{ url: blocked('https://reddit.com/') }, { id: 3 }, null, { id: 4, url: BLOCKED_PAGE }],
      restoreDeps(config([group()]), runtime()),
    );
    expect(actions).toEqual([]);
  });
});
