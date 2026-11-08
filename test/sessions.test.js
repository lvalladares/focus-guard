import { describe, it, expect } from 'vitest';
import { startSession, deriveGroupRuntime, reconcile, isOverrideActive, emptyRuntime } from '../src/lib/sessions.js';
import { COOLDOWN_MS } from '../src/lib/constants.js';

const NOW = 1700000000000;
const MIN = 60 * 1000;

describe('startSession', () => {
  it.each([10, 20, 30])('creates a session of %i minutes with absolute timestamps', (minutes) => {
    const session = startSession({ groupId: 'g1', minutes, now: NOW });
    expect(session).toEqual({ startedAt: NOW, endsAt: NOW + minutes * MIN, minutes });
  });
});

describe('deriveGroupRuntime', () => {
  it('returns none when there is no state', () => {
    expect(deriveGroupRuntime('g1', emptyRuntime(), NOW)).toEqual({ state: 'none' });
    expect(deriveGroupRuntime('g1', null, NOW)).toEqual({ state: 'none' });
  });

  it('detects an active session', () => {
    const runtime = { sessions: { g1: startSession({ groupId: 'g1', minutes: 10, now: NOW }) }, cooldowns: {}, override: null };
    const rt = deriveGroupRuntime('g1', runtime, NOW + 5 * MIN);
    expect(rt.state).toBe('session');
    expect(rt.sessionRemainingMs).toBe(5 * MIN);
  });

  it('derives a cooldown from a stale session even if never formalized', () => {
    const runtime = { sessions: { g1: startSession({ groupId: 'g1', minutes: 10, now: NOW }) }, cooldowns: {}, override: null };
    const rt = deriveGroupRuntime('g1', runtime, NOW + 12 * MIN);
    expect(rt.state).toBe('cooldown');
    expect(rt.cooldownRemainingMs).toBe(NOW + 10 * MIN + COOLDOWN_MS - (NOW + 12 * MIN));
  });

  it('prefers the recorded cooldown when present', () => {
    const runtime = { sessions: {}, cooldowns: { g1: { startedAt: NOW, until: NOW + 3 * MIN } }, override: null };
    const rt = deriveGroupRuntime('g1', runtime, NOW + 1 * MIN);
    expect(rt.state).toBe('cooldown');
    expect(rt.cooldownRemainingMs).toBe(2 * MIN);
  });

  it('returns none when everything expired long ago', () => {
    const runtime = { sessions: { g1: startSession({ groupId: 'g1', minutes: 10, now: NOW }) }, cooldowns: {}, override: null };
    expect(deriveGroupRuntime('g1', runtime, NOW + 10 * MIN + COOLDOWN_MS + 1).state).toBe('none');
  });
});

describe('reconcile', () => {
  it('keeps active sessions and cooldowns untouched', () => {
    const runtime = {
      sessions: { g1: startSession({ groupId: 'g1', minutes: 10, now: NOW }) },
      cooldowns: { g2: { startedAt: NOW, until: NOW + 5 * MIN } },
      override: { until: NOW + 30 * MIN },
    };
    const { runtime: rt, changes } = reconcile(runtime, NOW + 1 * MIN);
    expect(changes).toEqual([]);
    expect(rt.sessions.g1).toBe(runtime.sessions.g1);
    expect(rt.cooldowns.g2).toEqual(runtime.cooldowns.g2);
    expect(rt.override).toEqual({ until: NOW + 30 * MIN });
  });

  it('formalizes an expired session into a cooldown and reports a change', () => {
    const session = startSession({ groupId: 'g1', minutes: 10, now: NOW });
    const { runtime: rt, changes } = reconcile({ sessions: { g1: session }, cooldowns: {}, override: null }, NOW + 12 * MIN);
    expect(changes).toEqual([{ type: 'session-ended', groupId: 'g1', endsAt: session.endsAt }]);
    expect(rt.sessions).toEqual({});
    expect(rt.cooldowns.g1).toEqual({ startedAt: session.endsAt, until: session.endsAt + COOLDOWN_MS });
  });

  it('silently drops long-dead sessions without sweep events', () => {
    const session = startSession({ groupId: 'g1', minutes: 10, now: NOW });
    const { runtime: rt, changes } = reconcile({ sessions: { g1: session }, cooldowns: {}, override: null }, NOW + 60 * MIN);
    expect(changes).toEqual([]);
    expect(rt.sessions).toEqual({});
    expect(rt.cooldowns).toEqual({});
  });

  it('drops expired cooldowns and overrides', () => {
    const { runtime: rt } = reconcile(
      { sessions: {}, cooldowns: { g1: { startedAt: NOW, until: NOW + 1 } }, override: { until: NOW + 1 } },
      NOW + 10,
    );
    expect(rt.cooldowns).toEqual({});
    expect(rt.override).toBeNull();
  });

  it('merges a recorded cooldown with a derived one keeping the later end', () => {
    const session = startSession({ groupId: 'g1', minutes: 10, now: NOW });
    const earlierCooldown = { startedAt: NOW + 100 * MIN, until: NOW + 150 * MIN };
    const { runtime: rt } = reconcile({ sessions: { g1: session }, cooldowns: { g1: earlierCooldown }, override: null }, NOW + 50 * MIN);
    expect(rt.cooldowns.g1.until).toBe(NOW + 150 * MIN);
    expect(rt.cooldowns.g1.startedAt).toBe(session.endsAt);
  });
});

describe('isOverrideActive', () => {
  it('only counts future overrides', () => {
    expect(isOverrideActive({ override: { until: NOW + 1 } }, NOW)).toBe(true);
    expect(isOverrideActive({ override: { until: NOW - 1 } }, NOW)).toBe(false);
    expect(isOverrideActive(null, NOW)).toBe(false);
    expect(isOverrideActive({}, NOW)).toBe(false);
  });
});
