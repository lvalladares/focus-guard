import { describe, it, expect } from 'vitest';
import {
  evaluate,
  isBlockActive,
  isBlockingActive,
  isAntiUninstallActive,
  isExtensionsManagementUrl,
} from '../src/lib/decision.js';
import { activateBlockSnooze, addBlockUsage, emptyBlockState } from '../src/lib/sessions.js';

const NOW = new Date('2026-11-09T10:00:00').getTime(); // Monday 10:00
const MON_20 = new Date('2026-11-09T20:00:00').getTime();
const MIN = 60 * 1000;

function makeBlock(overrides = {}) {
  return {
    id: 'b1',
    name: 'Focus Block',
    enabled: true,
    persistent: false,
    sites: [
      { id: 's1', domain: 'blocked.com', includeBaseHost: true, includeAllSubdomains: false, subdomains: [], whitelist: [] },
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
    wallpaper: { mode: 'builtin', value: 'aurora' },
    ...extra,
  };
}

const runtime = (overrides = {}) => ({ override: null, ...overrides });

describe('isBlockActive / isBlockingActive', () => {
  it('activates blocks inside their schedule and respects master outside schedule', () => {
    const cfg = makeConfig([makeBlock()]);
    expect(isBlockingActive(NOW, cfg, runtime())).toBe(true);
    expect(isBlockingActive(MON_20, cfg, runtime())).toBe(false);
    expect(isBlockingActive(MON_20, { ...cfg, master: { enabled: true } }, runtime())).toBe(true);
  });

  it('pauses non-persistent blocks on override but never pauses persistent blocks', () => {
    const bNon = makeBlock({ id: 'b_non', persistent: false });
    const bPer = makeBlock({ id: 'b_per', persistent: true });
    const cfg = makeConfig([bNon, bPer]);
    const rt = runtime({ override: { until: NOW + 60 * MIN } });
    expect(isBlockActive(bNon, NOW, cfg, rt)).toBe(false);
    expect(isBlockActive(bPer, NOW, cfg, rt)).toBe(true);
  });
});

describe('anti-uninstall evaluation', () => {
  it('blocks chrome://extensions only when antiUninstall is enabled AND a persistent block is active', () => {
    const cfgPersistent = makeConfig(
      [makeBlock({ persistent: true })],
      { antiUninstall: { enabled: true } },
    );
    expect(isExtensionsManagementUrl('chrome://extensions/')).toBe(true);
    expect(isExtensionsManagementUrl('chrome://settings/extensions')).toBe(true);
    expect(isExtensionsManagementUrl('https://example.com')).toBe(false);

    expect(isAntiUninstallActive(cfgPersistent, NOW)).toBe(true);
    expect(evaluate({ url: 'chrome://extensions/', now: NOW, config: cfgPersistent, runtime: runtime() }).verdict)
      .toBe('block-anti-uninstall');

    // Outside persistent block's schedule -> allowed
    expect(isAntiUninstallActive(cfgPersistent, MON_20)).toBe(false);
    expect(evaluate({ url: 'chrome://extensions/', now: MON_20, config: cfgPersistent, runtime: runtime() }).verdict)
      .toBe('allow');

    // Non-persistent block active -> allowed
    const cfgNonPersistent = makeConfig([makeBlock({ persistent: false })], { antiUninstall: { enabled: true } });
    expect(isAntiUninstallActive(cfgNonPersistent, NOW)).toBe(false);
    expect(evaluate({ url: 'chrome://extensions/', now: NOW, config: cfgNonPersistent, runtime: runtime() }).verdict)
      .toBe('allow');
  });
});

describe('evaluate', () => {
  it('allows unmatched and whitelisted URLs', () => {
    const cfg = makeConfig([
      makeBlock({
        sites: [{ id: 's1', domain: 'blocked.com', includeBaseHost: true, includeAllSubdomains: false, subdomains: [], whitelist: ['/docs', '/help*'] }],
      }),
    ]);
    expect(evaluate({ url: 'https://example.com/', now: NOW, config: cfg, runtime: runtime() }).verdict).toBe('allow');
    const wl = evaluate({ url: 'https://blocked.com/docs/api', now: NOW, config: cfg, runtime: runtime() });
    expect(wl.verdict).toBe('allow');
    expect(wl.whitelisted).toBe(true);
  });

  it('returns block for hard blocks and block-snoozable when snoozes are available', () => {
    const hardCfg = makeConfig([makeBlock()]);
    expect(evaluate({ url: 'https://blocked.com/', now: NOW, config: hardCfg, runtime: runtime() }).verdict).toBe('block');

    const snoozeCfg = makeConfig([makeBlock({ snooze: { enabled: true, durationMinutes: 5, maxCount: 2, periodHours: 4 } })]);
    const res = evaluate({ url: 'https://blocked.com/', now: NOW, config: snoozeCfg, runtime: runtime(), blockStates: {} });
    expect(res.verdict).toBe('block-snoozable');
    expect(res.snoozableBlocks).toHaveLength(1);
    expect(res.snoozableBlocks[0].rt.snoozesLeft).toBe(2);
  });

  it('allows during active snooze, then blocks when snoozes are exhausted', () => {
    const block = makeBlock({ snooze: { enabled: true, durationMinutes: 5, maxCount: 1, periodHours: 4 } });
    const cfg = makeConfig([block]);
    const { state } = activateBlockSnooze(block, emptyBlockState(), NOW);

    const active = evaluate({ url: 'https://blocked.com/', now: NOW + 2 * MIN, config: cfg, runtime: runtime(), blockStates: { b1: state } });
    expect(active.verdict).toBe('allow');
    expect(active.activeTimer.mode).toBe('snooze');
    expect(active.activeTimer.remainingMs).toBe(3 * MIN);

    const exhausted = evaluate({ url: 'https://blocked.com/', now: NOW + 6 * MIN, config: cfg, runtime: runtime(), blockStates: { b1: state } });
    expect(exhausted.verdict).toBe('block');
    expect(exhausted.reason).toBe('snoozes-exhausted');
  });

  it('allows global time limit budget first, then transitions to snoozable once budget is spent', () => {
    const block = makeBlock({
      timeLimit: { enabled: true, minutes: 20, periodHours: 8 },
      snooze: { enabled: true, durationMinutes: 5, maxCount: 1, periodHours: 4 },
    });
    const cfg = makeConfig([block]);

    const resFresh = evaluate({ url: 'https://blocked.com/', now: NOW, config: cfg, runtime: runtime(), blockStates: {} });
    expect(resFresh.verdict).toBe('allow');
    expect(resFresh.activeTimer.mode).toBe('budget');
    expect(resFresh.activeTimer.remainingMs).toBe(20 * MIN);
    expect(resFresh.budgetBlocks).toHaveLength(1);

    const spentState = addBlockUsage(block, emptyBlockState(), 20 * MIN, NOW + 20 * MIN);
    const resSpent = evaluate({ url: 'https://blocked.com/', now: NOW + 20 * MIN, config: cfg, runtime: runtime(), blockStates: { b1: spentState } });
    expect(resSpent.verdict).toBe('block-snoozable');
    expect(resSpent.reason).toBe('budget-exhausted');
  });

  it('applies most-restrictive-wins when a URL matches multiple active blocks', () => {
    const b1 = makeBlock({ id: 'b1', name: 'Hard' });
    const b2 = makeBlock({
      id: 'b2',
      name: 'Soft',
      snooze: { enabled: true, durationMinutes: 5, maxCount: 2, periodHours: 4 },
    });
    const cfg = makeConfig([b1, b2]);
    const res = evaluate({ url: 'https://blocked.com/', now: NOW, config: cfg, runtime: runtime(), blockStates: {} });
    expect(res.verdict).toBe('block');
    expect(res.primaryBlock.id).toBe('b1');
  });

  it('combines multiple active budget/snooze blocks and picks the shortest remaining timer', () => {
    const b1 = makeBlock({
      id: 'b1',
      name: 'Budget10',
      timeLimit: { enabled: true, minutes: 10, periodHours: 8 },
    });
    const b2 = makeBlock({
      id: 'b2',
      name: 'Budget25',
      timeLimit: { enabled: true, minutes: 25, periodHours: 8 },
    });
    const cfg = makeConfig([b1, b2]);
    const res = evaluate({ url: 'https://blocked.com/', now: NOW, config: cfg, runtime: runtime(), blockStates: {} });
    expect(res.verdict).toBe('allow');
    expect(res.budgetBlocks).toHaveLength(2);
    expect(res.activeTimer.blockId).toBe('b1');
    expect(res.activeTimer.remainingMs).toBe(10 * MIN);
  });
});
