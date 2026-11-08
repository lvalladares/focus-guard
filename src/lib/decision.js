import { matchGroupForUrl, isWhitelistedUrl } from './patterns.js';
import { isWithinSchedule } from './schedule.js';
import { isOverrideActive, deriveGroupRuntime } from './sessions.js';
import { safeParseUrl } from './url.js';

export function isBlockingActive(nowMs, config, runtime) {
  const inSchedule = isWithinSchedule(new Date(nowMs), config.schedule);
  if (inSchedule) return !isOverrideActive(runtime, nowMs);
  return Boolean(config.master && config.master.enabled);
}

function allow(extra) {
  return { verdict: 'allow', group: null, blockingActive: false, whitelisted: false, session: null, sessionRemainingMs: null, cooldownRemainingMs: null, ...(extra || {}) };
}

export function evaluate({ url, now, config, runtime }) {
  const parsed = safeParseUrl(url);
  if (!parsed) return allow();
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return allow();

  const match = matchGroupForUrl(url, config);
  if (!match) return allow();

  const group = match.group;
  if (isWhitelistedUrl(parsed, group)) {
    return { ...allow(), group, whitelisted: true };
  }

  const blockingActive = isBlockingActive(now, config, runtime);
  if (!blockingActive) {
    return { ...allow(), group };
  }

  const rt = deriveGroupRuntime(group.id, runtime, now);

  if (group.level === 'total') {
    return { verdict: 'block', group, blockingActive: true, whitelisted: false, session: null, sessionRemainingMs: null, cooldownRemainingMs: null };
  }

  if (rt.state === 'session') {
    return { verdict: 'allow', group, blockingActive: true, whitelisted: false, session: rt.session, sessionRemainingMs: rt.sessionRemainingMs, cooldownRemainingMs: null };
  }
  if (rt.state === 'cooldown') {
    return { verdict: 'cooldown', group, blockingActive: true, whitelisted: false, session: null, sessionRemainingMs: null, cooldownRemainingMs: rt.cooldownRemainingMs };
  }
  return { verdict: 'gate', group, blockingActive: true, whitelisted: false, session: null, sessionRemainingMs: null, cooldownRemainingMs: null };
}
