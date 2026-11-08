import { COOLDOWN_MS } from './constants.js';

export function emptyRuntime() {
  return { sessions: {}, cooldowns: {}, override: null };
}

export function startSession({ minutes, now }) {
  return { startedAt: now, endsAt: now + minutes * 60 * 1000, minutes };
}

export function isOverrideActive(runtime, now) {
  return Boolean(runtime && runtime.override && runtime.override.until > now);
}

export function deriveGroupRuntime(groupId, runtime, now) {
  const session = runtime && runtime.sessions ? runtime.sessions[groupId] : null;
  if (session && session.endsAt > now) {
    return { state: 'session', session, sessionRemainingMs: session.endsAt - now };
  }
  const recorded = runtime && runtime.cooldowns ? runtime.cooldowns[groupId] : null;
  let until = recorded ? recorded.until : null;
  if (!until && session) until = session.endsAt + COOLDOWN_MS;
  if (until && until > now) {
    return { state: 'cooldown', cooldownUntil: until, cooldownRemainingMs: until - now };
  }
  return { state: 'none' };
}

export function reconcile(runtime, now) {
  const rt = {
    sessions: { ...((runtime && runtime.sessions) || {}) },
    cooldowns: { ...((runtime && runtime.cooldowns) || {}) },
    override: (runtime && runtime.override) || null,
  };
  const changes = [];

  for (const [groupId, session] of Object.entries(rt.sessions)) {
    if (session.endsAt > now) continue;
    const derivedUntil = session.endsAt + COOLDOWN_MS;
    const existing = rt.cooldowns[groupId];
    const existingUntil = existing ? existing.until : 0;
    const until = Math.max(derivedUntil, existingUntil);
    if (until > now) {
      rt.cooldowns[groupId] = {
        startedAt: Math.min(existing ? existing.startedAt : session.endsAt, session.endsAt),
        until,
      };
      if (derivedUntil > now) changes.push({ type: 'session-ended', groupId, endsAt: session.endsAt });
    }
    delete rt.sessions[groupId];
  }

  for (const [groupId, cooldown] of Object.entries(rt.cooldowns)) {
    if (!cooldown || cooldown.until <= now) delete rt.cooldowns[groupId];
  }

  if (rt.override && rt.override.until <= now) rt.override = null;

  return { runtime: rt, changes };
}
