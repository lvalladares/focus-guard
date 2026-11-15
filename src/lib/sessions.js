import { COOLDOWN_MS } from './constants.js';

const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

export function emptyRuntime() {
  return { override: null };
}

export function emptyBlockState() {
  return {
    snooze: null,
    snoozeHistory: [],
    usageWindow: null,
    updatedAt: 0,
  };
}

export function normalizeBlockState(raw) {
  if (!raw || typeof raw !== 'object') return emptyBlockState();
  const snooze = raw.snooze && typeof raw.snooze === 'object' && Number.isFinite(raw.snooze.endsAt)
    ? {
        startedAt: Number(raw.snooze.startedAt) || 0,
        endsAt: Number(raw.snooze.endsAt),
        durationMinutes: Number(raw.snooze.durationMinutes) || 0,
      }
    : null;
  const snoozeHistory = Array.isArray(raw.snoozeHistory)
    ? [...new Set(raw.snoozeHistory.map(Number).filter((ts) => Number.isFinite(ts) && ts > 0))].sort((a, b) => a - b)
    : [];
  const usageWindow = raw.usageWindow && typeof raw.usageWindow === 'object' && Number.isFinite(raw.usageWindow.startedAt)
    ? {
        startedAt: Number(raw.usageWindow.startedAt),
        usedMs: Math.max(0, Number(raw.usageWindow.usedMs) || 0),
      }
    : null;
  return {
    snooze,
    snoozeHistory,
    usageWindow,
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

export function isOverrideActive(runtime, now) {
  return Boolean(runtime && runtime.override && runtime.override.until > now);
}

export function deriveBlockRuntime(block, rawState, now) {
  const state = normalizeBlockState(rawState);

  const timeLimitCfg = block && block.timeLimit;
  const hasLimit = Boolean(timeLimitCfg && timeLimitCfg.enabled);
  const limitPeriodMs = hasLimit ? Math.max(1, timeLimitCfg.periodHours * HOUR_MS) : 0;
  const limitMs = hasLimit ? Math.max(1, timeLimitCfg.minutes * MIN_MS) : 0;

  let budgetUsedMs = 0;
  let budgetRemainingMs = 0;
  let budgetResetAt = null;
  if (hasLimit) {
    const win = state.usageWindow;
    if (win && now < win.startedAt + limitPeriodMs) {
      budgetUsedMs = Math.min(limitMs, Math.max(0, win.usedMs));
      budgetRemainingMs = Math.max(0, limitMs - budgetUsedMs);
      budgetResetAt = win.startedAt + limitPeriodMs;
    } else {
      budgetUsedMs = 0;
      budgetRemainingMs = limitMs;
      budgetResetAt = null;
    }
  }

  const snoozeCfg = block && block.snooze;
  const hasSnooze = Boolean(snoozeCfg && snoozeCfg.enabled && snoozeCfg.maxCount > 0);
  const snoozePeriodMs = hasSnooze ? Math.max(1, snoozeCfg.periodHours * HOUR_MS) : 0;
  const recentSnoozes = hasSnooze
    ? state.snoozeHistory.filter((ts) => ts > now - snoozePeriodMs && ts <= now)
    : [];
  const snoozeMax = hasSnooze ? snoozeCfg.maxCount : 0;
  const snoozesUsed = recentSnoozes.length;
  const snoozesLeft = hasSnooze ? Math.max(0, snoozeMax - snoozesUsed) : 0;
  const nextSnoozeAt = hasSnooze && snoozesLeft === 0 && recentSnoozes.length > 0
    ? recentSnoozes[0] + snoozePeriodMs
    : null;

  if (state.snooze && state.snooze.endsAt > now) {
    return {
      state: 'snooze',
      snooze: state.snooze,
      remainingMs: state.snooze.endsAt - now,
      budgetRemainingMs,
      budgetResetAt,
      snoozesLeft,
      snoozeMax,
      nextSnoozeAt,
    };
  }

  if (hasLimit && budgetRemainingMs > 0) {
    return {
      state: 'budget',
      remainingMs: budgetRemainingMs,
      limitMs,
      budgetUsedMs,
      budgetRemainingMs,
      budgetResetAt,
      snoozesLeft,
      snoozeMax,
      nextSnoozeAt,
    };
  }

  if (hasSnooze) {
    if (snoozesLeft > 0) {
      return {
        state: 'snoozable',
        snoozeDurationMinutes: snoozeCfg.durationMinutes,
        snoozesLeft,
        snoozeMax,
        nextSnoozeAt: null,
        budgetRemainingMs: 0,
        budgetResetAt,
      };
    }
    return {
      state: 'snoozes-exhausted',
      snoozeDurationMinutes: snoozeCfg.durationMinutes,
      snoozesLeft: 0,
      snoozeMax,
      nextSnoozeAt,
      budgetRemainingMs: 0,
      budgetResetAt,
    };
  }

  return {
    state: 'blocked',
    snoozesLeft: 0,
    snoozeMax: 0,
    nextSnoozeAt: null,
    budgetRemainingMs: 0,
    budgetResetAt,
  };
}

export function activateBlockSnooze(block, rawState, now) {
  const derived = deriveBlockRuntime(block, rawState, now);
  if (derived.state !== 'snoozable') {
    return { ok: false, error: 'Snooze is not available for this block right now', state: normalizeBlockState(rawState) };
  }
  const state = normalizeBlockState(rawState);
  const snoozePeriodMs = block.snooze.periodHours * HOUR_MS;
  const durationMinutes = block.snooze.durationMinutes;
  const snooze = {
    startedAt: now,
    endsAt: now + durationMinutes * MIN_MS,
    durationMinutes,
  };
  const snoozeHistory = state.snoozeHistory
    .filter((ts) => ts > now - snoozePeriodMs && ts <= now)
    .concat(now)
    .sort((a, b) => a - b);

  return {
    ok: true,
    snooze,
    state: {
      ...state,
      snooze,
      snoozeHistory,
      updatedAt: now,
    },
  };
}

export function endBlockSnooze(rawState, now) {
  const state = normalizeBlockState(rawState);
  if (!state.snooze) return state;
  return {
    ...state,
    snooze: null,
    updatedAt: now,
  };
}

export function addBlockUsage(block, rawState, deltaMs, now) {
  const state = normalizeBlockState(rawState);
  if (!block || !block.timeLimit || !block.timeLimit.enabled) return state;
  const safeDelta = Math.max(0, Number(deltaMs) || 0);
  if (safeDelta <= 0) return state;

  const periodMs = Math.max(1, block.timeLimit.periodHours * HOUR_MS);
  const limitMs = Math.max(1, block.timeLimit.minutes * MIN_MS);

  const win = state.usageWindow;
  let usageWindow;
  if (!win || now >= win.startedAt + periodMs) {
    usageWindow = {
      startedAt: now,
      usedMs: Math.min(limitMs, safeDelta),
    };
  } else {
    usageWindow = {
      startedAt: win.startedAt,
      usedMs: Math.min(limitMs, win.usedMs + safeDelta),
    };
  }

  return {
    ...state,
    usageWindow,
    updatedAt: now,
  };
}

export function reconcileBlockState(block, rawState, now) {
  const state = normalizeBlockState(rawState);
  let changed = false;
  const changes = [];

  let nextSnooze = state.snooze;
  if (nextSnooze && nextSnooze.endsAt <= now) {
    changes.push({ type: 'snooze-ended', blockId: block.id, endsAt: nextSnooze.endsAt });
    nextSnooze = null;
    changed = true;
  }

  let nextHistory = state.snoozeHistory;
  if (block && block.snooze && block.snooze.enabled) {
    const snoozePeriodMs = block.snooze.periodHours * HOUR_MS;
    const pruned = state.snoozeHistory.filter((ts) => ts > now - snoozePeriodMs && ts <= now);
    if (pruned.length !== state.snoozeHistory.length) {
      nextHistory = pruned;
      changed = true;
    }
  } else if (state.snoozeHistory.length > 0) {
    nextHistory = [];
    changed = true;
  }

  let nextUsage = state.usageWindow;
  if (block && block.timeLimit && block.timeLimit.enabled && nextUsage) {
    const periodMs = block.timeLimit.periodHours * HOUR_MS;
    if (now >= nextUsage.startedAt + periodMs) {
      changes.push({ type: 'budget-reset', blockId: block.id });
      nextUsage = null;
      changed = true;
    }
  } else if ((!block || !block.timeLimit || !block.timeLimit.enabled) && nextUsage) {
    nextUsage = null;
    changed = true;
  }

  if (!changed) return { state, changed: false, changes };
  return {
    state: {
      snooze: nextSnooze,
      snoozeHistory: nextHistory,
      usageWindow: nextUsage,
      updatedAt: now,
    },
    changed: true,
    changes,
  };
}

export function reconcileBlockStates(config, blockStates, now) {
  const nextStates = {};
  const allChanges = [];
  let anyChanged = false;
  for (const block of (config && config.blocks) || []) {
    const raw = blockStates ? blockStates[block.id] : null;
    const { state, changed, changes } = reconcileBlockState(block, raw, now);
    nextStates[block.id] = state;
    if (changed) anyChanged = true;
    allChanges.push(...changes);
  }
  return { blockStates: nextStates, changed: anyChanged, changes: allChanges };
}

export function reconcile(runtime, now) {
  const rt = {
    override: (runtime && runtime.override) || null,
  };
  if (rt.override && rt.override.until <= now) rt.override = null;
  return { runtime: rt, changes: [] };
}

// Legacy exports kept for any remaining helpers if needed
export function startSession({ minutes, now }) {
  return { startedAt: now, endsAt: now + minutes * MIN_MS, minutes };
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
