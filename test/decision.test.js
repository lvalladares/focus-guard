import { describe, it, expect } from 'vitest';
import { evaluate, isBlockingActive } from '../src/lib/decision.js';
import { startSession } from '../src/lib/sessions.js';

const NOW = new Date('2026-11-09T10:00:00').getTime();
const MONDAY_10 = new Date(NOW);
const MONDAY_20 = new Date('2026-11-09T20:00:00').getTime();

const baseConfig = {
  master: { enabled: false },
  schedule: { windows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }] },
  groups: [
    { id: 'total', domain: 'blocked.com', includeBaseHost: true, includeAllSubdomains: false, subdomains: [], whitelist: [], level: 'total' },
    { id: 'partial', domain: 'partial.com', includeBaseHost: true, includeAllSubdomains: false, subdomains: [], whitelist: [], level: 'partial' },
  ],
  wallpaper: { mode: 'builtin', value: 'aurora' },
};

function runtime(overrides = {}) {
  return { sessions: {}, cooldowns: {}, override: null, ...overrides };
}

describe('isBlockingActive', () => {
  it('is on inside the schedule and off outside unless master is on', () => {
    expect(isBlockingActive(MONDAY_10.getTime(), baseConfig, runtime())).toBe(true);
    expect(isBlockingActive(MONDAY_20, baseConfig, runtime())).toBe(false);
    expect(isBlockingActive(MONDAY_20, { ...baseConfig, master: { enabled: true } }, runtime())).toBe(true);
  });

  it('honors the confirmed-off override inside the schedule', () => {
    expect(isBlockingActive(MONDAY_10.getTime(), baseConfig, runtime({ override: { until: MONDAY_10.getTime() + 3600000 } }))).toBe(false);
    expect(isBlockingActive(MONDAY_10.getTime(), baseConfig, runtime({ override: { until: MONDAY_10.getTime() - 1 } }))).toBe(true);
  });
});

describe('evaluate', () => {
  it('allows unrated URLs', () => {
    expect(evaluate({ url: 'https://example.com/', now: NOW, config: baseConfig, runtime: runtime() }).verdict).toBe('allow');
  });

  it('allows non-http schemes', () => {
    expect(evaluate({ url: 'chrome-extension://abc/x.html', now: NOW, config: baseConfig, runtime: runtime() }).verdict).toBe('allow');
    expect(evaluate({ url: 'file:///C:/x', now: NOW, config: baseConfig, runtime: runtime() }).verdict).toBe('allow');
    expect(evaluate({ url: 'garbage', now: NOW, config: baseConfig, runtime: runtime() }).verdict).toBe('allow');
  });

  it('blocks total groups during the schedule', () => {
    const result = evaluate({ url: 'https://blocked.com/x', now: NOW, config: baseConfig, runtime: runtime() });
    expect(result.verdict).toBe('block');
    expect(result.group.id).toBe('total');
  });

  it('gates partial groups during the schedule', () => {
    const result = evaluate({ url: 'https://partial.com/x', now: NOW, config: baseConfig, runtime: runtime() });
    expect(result.verdict).toBe('gate');
    expect(result.group.id).toBe('partial');
  });

  it('allows everything when blocking is off', () => {
    const result = evaluate({ url: 'https://blocked.com/x', now: MONDAY_20, config: baseConfig, runtime: runtime() });
    expect(result.verdict).toBe('allow');
    expect(result.group.id).toBe('total');
  });

  it('allows partial sites during an active session', () => {
    const rt = runtime({ sessions: { partial: startSession({ groupId: 'partial', minutes: 10, now: NOW - 60 * 1000 }) } });
    const result = evaluate({ url: 'https://partial.com/x', now: NOW, config: baseConfig, runtime: rt });
    expect(result.verdict).toBe('allow');
    expect(result.session.minutes).toBe(10);
    expect(result.sessionRemainingMs).toBe(9 * 60 * 1000);
  });

  it('shows cooldown after a session expires', () => {
    const rt = runtime({ sessions: { partial: startSession({ groupId: 'partial', minutes: 10, now: NOW - 11 * 60 * 1000 }) } });
    const result = evaluate({ url: 'https://partial.com/x', now: NOW, config: baseConfig, runtime: rt });
    expect(result.verdict).toBe('cooldown');
    expect(result.cooldownRemainingMs).toBe(9 * 60 * 1000);
  });

  it('gates again after the cooldown expires', () => {
    const rt = runtime({ cooldowns: { partial: { startedAt: NOW - 11 * 60 * 1000, until: NOW - 1 } } });
    expect(evaluate({ url: 'https://partial.com/x', now: NOW, config: baseConfig, runtime: rt }).verdict).toBe('gate');
  });

  it('respects whitelisted paths above everything', () => {
    const config = {
      ...baseConfig,
      groups: [{ id: 'total', domain: 'blocked.com', includeBaseHost: true, includeAllSubdomains: false, subdomains: [], whitelist: ['/docs', '/help*'], level: 'total' }],
    };
    expect(evaluate({ url: 'https://blocked.com/docs/api', now: NOW, config, runtime: runtime() }).verdict).toBe('allow');
    expect(evaluate({ url: 'https://blocked.com/help/me', now: NOW, config, runtime: runtime() }).verdict).toBe('allow');
    const result = evaluate({ url: 'https://blocked.com/other', now: NOW, config, runtime: runtime() });
    expect(result.verdict).toBe('block');
    expect(result.whitelisted).toBe(false);
    const wl = evaluate({ url: 'https://blocked.com/docs/api', now: NOW, config, runtime: runtime() });
    expect(wl.whitelisted).toBe(true);
  });

  it('respects the confirmed-off override', () => {
    const rt = runtime({ override: { until: NOW + 3600000 } });
    expect(evaluate({ url: 'https://blocked.com/x', now: NOW, config: baseConfig, runtime: rt }).verdict).toBe('allow');
  });

  it('blocks via master toggle outside the schedule', () => {
    const config = { ...baseConfig, master: { enabled: true } };
    expect(evaluate({ url: 'https://blocked.com/x', now: MONDAY_20, config, runtime: runtime() }).verdict).toBe('block');
    expect(evaluate({ url: 'https://partial.com/x', now: MONDAY_20, config, runtime: runtime() }).verdict).toBe('gate');
  });

  it('matches hosts strictly even when subdomains are not included', () => {
    expect(evaluate({ url: 'https://old.blocked.com/x', now: NOW, config: baseConfig, runtime: runtime() }).verdict).toBe('allow');
  });
});
