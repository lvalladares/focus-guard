import { normalizeConfig, defaultConfig } from '../lib/config.js';
import { buildRules, diffRules } from '../lib/rules-builder.js';
import { reconcile, startSession, isOverrideActive } from '../lib/sessions.js';
import { evaluate } from '../lib/decision.js';
import { isWithinSchedule, scheduleBlockingEnd, nextScheduleChange } from '../lib/schedule.js';
import { groupMatchPatterns } from '../lib/patterns.js';
import { FREE_TIME_OPTIONS, COOLDOWN_MS, STORAGE_KEYS, PAGES } from '../lib/constants.js';
import { safeParseUrl } from '../lib/url.js';

const CONFIG_KEY = STORAGE_KEYS.CONFIG;
const RUNTIME_KEY = STORAGE_KEYS.RUNTIME;

let syncing = false;
let syncQueued = false;

async function readState() {
  const store = await chrome.storage.local.get([CONFIG_KEY, RUNTIME_KEY]);
  const { config } = normalizeConfig(store[CONFIG_KEY]);
  const runtime = store[RUNTIME_KEY] || { sessions: {}, cooldowns: {}, override: null };
  return { config, runtime };
}

async function persistRuntime(runtime) {
  await chrome.storage.local.set({ [RUNTIME_KEY]: runtime });
}

function sanitizeRule(rule) {
  return {
    id: rule.id,
    priority: rule.priority,
    condition: {
      regexFilter: rule.condition ? rule.condition.regexFilter : undefined,
      resourceTypes: rule.condition && rule.condition.resourceTypes ? [...rule.condition.resourceTypes] : undefined,
    },
    action: {
      type: rule.action ? rule.action.type : undefined,
      ...(rule.action && rule.action.redirect
        ? { redirect: { regexSubstitution: rule.action.redirect.regexSubstitution } }
        : {}),
    },
  };
}

function blockedUrlFor(url) {
  return `${chrome.runtime.getURL(PAGES.BLOCKED)}#${encodeURIComponent(url)}`;
}

async function sweepGroupTabs(groupId, config, runtime) {
  const group = config.groups.find((g) => g.id === groupId);
  if (!group) return;
  const patterns = groupMatchPatterns(group);
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: patterns });
  } catch (error) {
    console.error('Focus Guard: tab sweep failed', error);
    return;
  }
  const now = Date.now();
  for (const tab of tabs) {
    if (!tab.url || !tab.id) continue;
    const result = evaluate({ url: tab.url, now, config, runtime });
    if (result.verdict === 'block' || result.verdict === 'cooldown') {
      try {
        await chrome.tabs.update(tab.id, { url: blockedUrlFor(tab.url) });
      } catch (error) {
        console.error('Focus Guard: tab redirect failed', error);
      }
    }
  }
}

async function ensureAlarms(config, runtime, now) {
  for (const [groupId, session] of Object.entries(runtime.sessions || {})) {
    if (session.endsAt > now) chrome.alarms.create(`session-end:${groupId}`, { when: session.endsAt });
  }
  for (const [groupId, cooldown] of Object.entries(runtime.cooldowns || {})) {
    if (cooldown.until > now) chrome.alarms.create(`cooldown-end:${groupId}`, { when: cooldown.until });
  }
  if (runtime.override && runtime.override.until > now) {
    chrome.alarms.create('override-end', { when: runtime.override.until });
  }
  const next = nextScheduleChange(new Date(now), config.schedule);
  if (next) chrome.alarms.create('schedule-boundary', { when: next.getTime() });
  const tick = await chrome.alarms.get('tick');
  if (!tick) chrome.alarms.create('tick', { periodInMinutes: 1 });
}

async function sync() {
  if (syncing) {
    syncQueued = true;
    return;
  }
  syncing = true;
  try {
    const { config, runtime: raw } = await readState();
    const now = Date.now();
    const { runtime, changes } = reconcile(raw, now);
    if (changes.length > 0 || JSON.stringify(runtime) !== JSON.stringify(raw)) {
      await persistRuntime(runtime);
    }
    const desired = buildRules({ config, runtime, now, extensionId: chrome.runtime.id });
    const current = (await chrome.declarativeNetRequest.getDynamicRules()).map(sanitizeRule);
    const { removeRuleIds, addRules } = diffRules(current, desired);
    if (removeRuleIds.length > 0 || addRules.length > 0) {
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
      } catch (error) {
        console.error('Focus Guard: updating dynamic rules failed', error, { removeRuleIds, addRules });
      }
    }
    await ensureAlarms(config, runtime, now);
    for (const change of changes) {
      if (change.type === 'session-ended') await sweepGroupTabs(change.groupId, config, runtime);
    }
  } catch (error) {
    console.error('Focus Guard: sync failed', error);
  } finally {
    syncing = false;
    if (syncQueued) {
      syncQueued = false;
      await sync();
    }
  }
}

async function openSettings() {
  const url = chrome.runtime.getURL(PAGES.SETTINGS);
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

async function handleMessage(msg) {
  switch (msg && msg.type) {
    case 'state:get': {
      const { config, runtime } = await readState();
      return { ok: true, config, runtime, now: Date.now() };
    }
    case 'config:save': {
      const { config, errors } = normalizeConfig(msg.config);
      if (errors.length > 0) return { ok: false, errors };
      await chrome.storage.local.set({ [CONFIG_KEY]: config });
      await sync();
      return { ok: true, config };
    }
    case 'session:start': {
      const { config, runtime } = await readState();
      const now = Date.now();
      const group = config.groups.find((g) => g.id === msg.groupId);
      if (!group || group.level !== 'partial') return { ok: false, error: 'Group is not partially blocked' };
      if (!FREE_TIME_OPTIONS.includes(msg.minutes)) return { ok: false, error: 'Invalid duration' };
      const target = safeParseUrl(msg.targetUrl);
      if (!target) return { ok: false, error: 'Invalid target URL' };
      const result = evaluate({ url: msg.targetUrl, now, config, runtime });
      if (result.verdict !== 'gate') return { ok: false, verdict: result.verdict };
      const session = startSession({ groupId: group.id, minutes: msg.minutes, now });
      const nextRuntime = {
        ...runtime,
        sessions: { ...runtime.sessions, [group.id]: session },
        cooldowns: { ...runtime.cooldowns },
      };
      delete nextRuntime.cooldowns[group.id];
      await persistRuntime(nextRuntime);
      await sync();
      return { ok: true, endsAt: session.endsAt };
    }
    case 'session:end': {
      const { config, runtime } = await readState();
      const now = Date.now();
      const session = runtime.sessions ? runtime.sessions[msg.groupId] : null;
      if (!session) return { ok: false, error: 'No active session' };
      const nextRuntime = {
        sessions: { ...runtime.sessions },
        cooldowns: { ...runtime.cooldowns },
        override: runtime.override,
      };
      delete nextRuntime.sessions[msg.groupId];
      nextRuntime.cooldowns[msg.groupId] = { startedAt: now, until: now + COOLDOWN_MS };
      await persistRuntime(nextRuntime);
      await sync();
      await sweepGroupTabs(msg.groupId, config, nextRuntime);
      return { ok: true };
    }
    case 'overlay:check': {
      const { config, runtime } = await readState();
      const result = evaluate({ url: msg.url, now: Date.now(), config, runtime });
      const active = result.verdict === 'allow' && result.session;
      return {
        ok: true,
        active: Boolean(active),
        groupId: result.group ? result.group.id : null,
        domain: result.group ? result.group.domain : null,
        remainingMs: active ? result.sessionRemainingMs : null,
        endsAt: active ? result.session.endsAt : null,
        verdict: result.verdict,
      };
    }
    case 'master:set': {
      const { config, runtime } = await readState();
      const now = Date.now();
      const inSchedule = isWithinSchedule(new Date(now), config.schedule);
      if (!msg.enabled && inSchedule && !isOverrideActive(runtime, now)) {
        return { ok: false, error: 'confirmation-required' };
      }
      if (msg.enabled && inSchedule && isOverrideActive(runtime, now)) {
        const nextRuntime = { ...runtime, override: null };
        await persistRuntime(nextRuntime);
        await sync();
        return { ok: true };
      }
      const nextConfig = { ...config, master: { enabled: Boolean(msg.enabled) } };
      await chrome.storage.local.set({ [CONFIG_KEY]: nextConfig });
      await sync();
      return { ok: true };
    }
    case 'override:off': {
      const { config, runtime } = await readState();
      const now = Date.now();
      if (!isWithinSchedule(new Date(now), config.schedule)) {
        return { ok: false, error: 'Not inside the schedule' };
      }
      const end = scheduleBlockingEnd(new Date(now), config.schedule);
      const until = end ? end.getTime() : now + 60 * 60 * 1000;
      const nextRuntime = { ...runtime, override: { until } };
      await persistRuntime(nextRuntime);
      await sync();
      return { ok: true, until };
    }
    case 'override:clear': {
      const { runtime } = await readState();
      const nextRuntime = { ...runtime, override: null };
      await persistRuntime(nextRuntime);
      await sync();
      return { ok: true };
    }
    default:
      return { ok: false, error: 'Unknown message' };
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const store = await chrome.storage.local.get(CONFIG_KEY);
  if (!store[CONFIG_KEY]) {
    await chrome.storage.local.set({ [CONFIG_KEY]: defaultConfig() });
  }
  await sync();
  if (details.reason === 'install') {
    await openSettings();
  }
});

chrome.runtime.onStartup.addListener(() => {
  sync();
});

chrome.alarms.onAlarm.addListener(() => {
  sync();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[CONFIG_KEY]) sync();
});

chrome.action.onClicked.addListener(() => {
  openSettings();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg).then(
    (response) => sendResponse(response),
    (error) => sendResponse({ ok: false, error: String(error && error.message ? error.message : error) }),
  );
  return true;
});

sync();
