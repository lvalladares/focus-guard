import { normalizeConfig, defaultConfig } from '../lib/config.js';
import { buildRules, diffRules } from '../lib/rules-builder.js';
import { reconcile, startSession, isOverrideActive } from '../lib/sessions.js';
import { evaluate } from '../lib/decision.js';
import { isWithinSchedule, scheduleBlockingEnd, nextScheduleChange } from '../lib/schedule.js';
import { createConfigStorage } from '../lib/config-storage.js';
import { groupMatchPatterns } from '../lib/patterns.js';
import { planSweep, planRestore } from '../lib/tab-sweep.js';
import { createSegmentTracker } from '../lib/stats-tracker.js';
import { createStatsStorage } from '../lib/stats-storage.js';
import { httpHostname } from '../lib/url.js';
import { FREE_TIME_OPTIONS, COOLDOWN_MS, STORAGE_KEYS, PAGES, STATS } from '../lib/constants.js';
import { safeParseUrl } from '../lib/url.js';

const CONFIG_KEY = STORAGE_KEYS.CONFIG;
const RUNTIME_KEY = STORAGE_KEYS.RUNTIME;

const configStorage = createConfigStorage({ sync: chrome.storage.sync, local: chrome.storage.local });

let syncing = false;
let syncQueued = false;

async function readState() {
  const config = await configStorage.getConfig();
  const store = await chrome.storage.local.get([RUNTIME_KEY]);
  return {
    config: normalizeConfig(config).config,
    runtime: store[RUNTIME_KEY] || { sessions: {}, cooldowns: {}, override: null },
  };
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

function gateUrlFor(url) {
  return `${chrome.runtime.getURL(PAGES.GATE)}#${encodeURIComponent(url)}`;
}

function redirectFor(url, verdict) {
  return verdict === 'gate' ? gateUrlFor(url) : blockedUrlFor(url);
}

async function redirectTab(action) {
  try {
    await chrome.tabs.update(action.tabId, { url: action.url });
  } catch (error) {
    console.error('Focus Guard: tab redirect failed', error);
  }
}

// Keeps open tabs in sync with the current blocking state, both ways:
// - tabs sitting on blocked sites are pulled to the block/gate pages (so turning blocking
//   on also blocks tabs that were already open), and
// - tabs parked on those pages are sent back to their original URL once it is allowed
//   again (blocking turned off, a dose running, a path whitelisted, a group removed).
async function convergeTabs(config, runtime, now) {
  const patterns = [...new Set((config.groups || []).flatMap(groupMatchPatterns))];
  if (patterns.length > 0) {
    try {
      const tabs = await chrome.tabs.query({ url: patterns });
      for (const action of planSweep(tabs, { config, runtime, now, redirectFor })) {
        await redirectTab(action);
      }
    } catch (error) {
      console.error('Focus Guard: tab sweep failed', error);
    }
  }
  try {
    const tabs = await chrome.tabs.query({});
    const pageDeps = {
      config,
      runtime,
      now,
      blockedPageUrl: chrome.runtime.getURL(PAGES.BLOCKED),
      gatePageUrl: chrome.runtime.getURL(PAGES.GATE),
    };
    for (const action of planRestore(tabs, pageDeps)) {
      await redirectTab(action);
    }
  } catch (error) {
    console.error('Focus Guard: tab restore failed', error);
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
    await convergeTabs(config, runtime, now);
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

const statsStorage = createStatsStorage({ storage: chrome.storage.local });
const segmentTracker = createSegmentTracker();

let statsReadyPromise = null;
let statsEnabled = true;
let focusedWindowId = null;

function ensureStatsReady() {
  if (!statsReadyPromise) {
    statsReadyPromise = initStats().catch((error) => {
      statsReadyPromise = null;
      console.error('Focus Guard: stats init failed', error);
    });
  }
  return statsReadyPromise;
}

async function initStats() {
  const { config } = await readState();
  statsEnabled = Boolean(config.stats && config.stats.enabled);
  const session = await chrome.storage.session.get(STATS.OPEN_KEY);
  if (session[STATS.OPEN_KEY]) segmentTracker.restoreCurrent(session[STATS.OPEN_KEY]);
  try {
    const window = await chrome.windows.getLastFocused();
    focusedWindowId = window ? window.id : null;
  } catch {
    focusedWindowId = null;
  }
}

async function statsFlush(emissions) {
  if (!emissions || emissions.length === 0) return;
  try {
    await statsStorage.flush(emissions);
  } catch (error) {
    console.error('Focus Guard: stats flush failed', error);
  }
}

async function persistOpenSegment() {
  try {
    const current = segmentTracker.getCurrent();
    if (current) await chrome.storage.session.set({ [STATS.OPEN_KEY]: current });
    else await chrome.storage.session.remove(STATS.OPEN_KEY);
  } catch {
    /* session storage unavailable */
  }
}

async function statsFocusTab(tabId, windowId) {
  await ensureStatsReady();
  if (!statsEnabled) return;
  let hostname = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    hostname = httpHostname(tab.url);
  } catch {
    hostname = null;
  }
  focusedWindowId = windowId;
  const emissions = segmentTracker.handleFocus({ hostname, tabId, windowId, time: Date.now() });
  await persistOpenSegment();
  await statsFlush(emissions);
}

async function statsTick() {
  await ensureStatsReady();
  if (!statsEnabled) return;
  const time = Date.now();
  const current = segmentTracker.getCurrent();
  if (current) {
    let tab = null;
    try {
      [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    } catch {
      tab = null;
    }
    const hostname = tab ? httpHostname(tab.url) : null;
    if (!tab || hostname !== current.hostname) {
      const emissions = segmentTracker.handleBlur(time);
      await persistOpenSegment();
      await statsFlush(emissions);
      return;
    }
  }
  const emissions = segmentTracker.checkpoint(time);
  await persistOpenSegment();
  await statsFlush(emissions);
}

async function disableStatsTracking() {
  const emissions = segmentTracker.handleBlur(Date.now());
  await persistOpenSegment();
  await statsFlush(emissions);
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
      await configStorage.setConfig(config);
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
      const { runtime } = await readState();
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
      await configStorage.setConfig(nextConfig);
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
  const config = await configStorage.getConfig();
  if (!config) {
    await configStorage.setConfig(defaultConfig());
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
  statsTick();
  sync();
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  statsFocusTab(tabId, windowId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  await ensureStatsReady();
  if (!statsEnabled) return;
  if (!tab || !tab.active || tab.windowId !== focusedWindowId) return;
  const emissions = segmentTracker.handleFocus({ hostname: httpHostname(changeInfo.url), tabId, windowId: tab.windowId, time: Date.now() });
  await persistOpenSegment();
  await statsFlush(emissions);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  await ensureStatsReady();
  focusedWindowId = windowId;
  if (!statsEnabled) return;
  const time = Date.now();
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    const emissions = segmentTracker.handleBlur(time);
    await persistOpenSegment();
    await statsFlush(emissions);
    return;
  }
  let tab = null;
  try {
    [tab] = await chrome.tabs.query({ active: true, windowId });
  } catch {
    tab = null;
  }
  const hostname = tab ? httpHostname(tab.url) : null;
  const emissions = segmentTracker.handleFocus({ hostname, tabId: tab ? tab.id : null, windowId, time });
  await persistOpenSegment();
  await statsFlush(emissions);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ensureStatsReady();
  if (!statsEnabled) return;
  const emissions = segmentTracker.handleTabRemoved(tabId, Date.now());
  if (emissions.length === 0) return;
  await persistOpenSegment();
  await statsFlush(emissions);
});

async function onConfigChanged(nextConfig) {
  if (statsReadyPromise) {
    const { config } = normalizeConfig(nextConfig);
    const enabled = Boolean(config.stats && config.stats.enabled);
    if (enabled !== statsEnabled) {
      statsEnabled = enabled;
      if (!enabled) await disableStatsTracking();
    }
  }
  sync();
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'sync' && changes[CONFIG_KEY]) {
    await onConfigChanged(changes[CONFIG_KEY].newValue);
    return;
  }
  if (area === 'local' && changes[CONFIG_KEY]) {
    await onConfigChanged(changes[CONFIG_KEY].newValue);
  }
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
