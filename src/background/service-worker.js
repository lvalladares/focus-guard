import {
  normalizeConfig,
  defaultConfig,
  hasActivePersistentBlock,
  validateLockedBlockChanges,
} from '../lib/config.js';
import { buildRules, diffRules } from '../lib/rules-builder.js';
import {
  reconcile,
  reconcileBlockStates,
  activateBlockSnooze,
  endBlockSnooze,
  addBlockUsage,
  deriveBlockRuntime,
} from '../lib/sessions.js';
import {
  evaluate,
  isAntiUninstallActive,
  isExtensionsManagementUrl,
} from '../lib/decision.js';
import { isScheduleActive, scheduleBlockingEnd, nextBlocksScheduleChange } from '../lib/schedule.js';
import { createConfigStorage } from '../lib/config-storage.js';
import { blockMatchPatterns } from '../lib/patterns.js';
import { planSweep, planRestore } from '../lib/tab-sweep.js';
import { createSegmentTracker } from '../lib/stats-tracker.js';
import { createStatsStorage } from '../lib/stats-storage.js';
import { httpHostname, safeParseUrl } from '../lib/url.js';
import {
  STORAGE_KEYS,
  PAGES,
  STATS,
  USAGE_SYNC_INTERVAL_MS,
} from '../lib/constants.js';

const CONFIG_KEY = STORAGE_KEYS.CONFIG;
const RUNTIME_KEY = STORAGE_KEYS.RUNTIME;
const USAGE_SESSION_KEY = 'focusUsageActive';

const configStorage = createConfigStorage({ sync: chrome.storage.sync, local: chrome.storage.local });

let syncing = false;
let syncQueued = false;

async function readState() {
  const rawConfig = await configStorage.getConfig();
  const config = normalizeConfig(rawConfig).config;
  const blockIds = config.blocks.map((b) => b.id);
  const [blockStates, store] = await Promise.all([
    configStorage.getBlockStates(blockIds),
    chrome.storage.local.get([RUNTIME_KEY]),
  ]);
  return {
    config,
    blockStates,
    runtime: store[RUNTIME_KEY] || { override: null },
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

function redirectFor(url) {
  return blockedUrlFor(url);
}

async function redirectTab(action) {
  try {
    await chrome.tabs.update(action.tabId, { url: action.url });
  } catch (error) {
    console.error('Focus Guard: tab redirect failed', error);
  }
}

async function enforceAntiUninstallOnTab(tabId, url, config, now) {
  if (!url || !isAntiUninstallActive(config, now)) return false;
  if (!isExtensionsManagementUrl(url)) return false;
  await redirectTab({ tabId, url: blockedUrlFor(url) });
  return true;
}

// Keeps open tabs in sync with the current blocking state, both ways:
// - tabs sitting on blocked sites (or chrome://extensions under anti-uninstall) are pulled to blocked.html
// - tabs parked on blocked.html are sent back to their original URL once allowed again
async function convergeTabs(config, runtime, blockStates, now) {
  const patterns = [...new Set((config.blocks || []).flatMap(blockMatchPatterns))];
  if (patterns.length > 0) {
    try {
      const tabs = await chrome.tabs.query({ url: patterns });
      for (const action of planSweep(tabs, { config, runtime, blockStates, now, redirectFor })) {
        await redirectTab(action);
      }
    } catch (error) {
      console.error('Focus Guard: tab sweep failed', error);
    }
  }
  try {
    const tabs = await chrome.tabs.query({});
    if (isAntiUninstallActive(config, now)) {
      for (const action of planSweep(
        tabs.filter((t) => isExtensionsManagementUrl(t.url)),
        { config, runtime, blockStates, now, redirectFor },
      )) {
        await redirectTab(action);
      }
    }
    const pageDeps = {
      config,
      runtime,
      blockStates,
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

async function ensureAlarms(config, runtime, blockStates, now) {
  for (const block of config.blocks || []) {
    const state = blockStates[block.id];
    if (!state) continue;
    if (state.snooze && state.snooze.endsAt > now) {
      chrome.alarms.create(`snooze-end:${block.id}`, { when: state.snooze.endsAt });
    }
    const rt = deriveBlockRuntime(block, state, now);
    if (rt.budgetResetAt && rt.budgetResetAt > now) {
      chrome.alarms.create(`budget-reset:${block.id}`, { when: rt.budgetResetAt });
    }
    if (rt.nextSnoozeAt && rt.nextSnoozeAt > now) {
      chrome.alarms.create(`snooze-unlock:${block.id}`, { when: rt.nextSnoozeAt });
    }
  }
  if (runtime.override && runtime.override.until > now) {
    chrome.alarms.create('override-end', { when: runtime.override.until });
  }
  const next = nextBlocksScheduleChange(new Date(now), config.blocks);
  if (next) chrome.alarms.create('schedule-boundary', { when: next.getTime() });
  const tick = await chrome.alarms.get('tick');
  if (!tick) chrome.alarms.create('tick', { periodInMinutes: 1 });
}

// --- Active tab global-time-limit usage tracking ---

let activeUsage = null;
let usageReadyPromise = null;
let usageQueue = Promise.resolve();

function serializeUsage(task) {
  const run = usageQueue.then(task, task);
  usageQueue = run.catch(() => {});
  return run;
}

async function loadActiveUsage() {
  try {
    const session = await chrome.storage.session.get(USAGE_SESSION_KEY);
    const saved = session[USAGE_SESSION_KEY];
    if (saved && typeof saved.url === 'string' && typeof saved.startedAt === 'number') {
      activeUsage = saved;
    }
  } catch {
    /* session storage unavailable */
  }
}

function ensureUsageReady() {
  if (!usageReadyPromise) {
    usageReadyPromise = loadActiveUsage().catch(() => {
      usageReadyPromise = null;
    });
  }
  return usageReadyPromise;
}

async function saveActiveUsage() {
  try {
    if (activeUsage) await chrome.storage.session.set({ [USAGE_SESSION_KEY]: activeUsage });
    else await chrome.storage.session.remove(USAGE_SESSION_KEY);
  } catch {
    /* session storage unavailable */
  }
}

function scheduleBudgetAlarmsForUrl(url, config, runtime, blockStates, now) {
  if (!url) return;
  const result = evaluate({ url, now, config, runtime, blockStates });
  if (result.verdict === 'allow' && result.budgetBlocks && result.budgetBlocks.length > 0) {
    let minRemaining = Infinity;
    for (const block of result.budgetBlocks) {
      const rt = deriveBlockRuntime(block, blockStates[block.id], now);
      if (rt.state === 'budget' && rt.budgetRemainingMs > 0) {
        minRemaining = Math.min(minRemaining, rt.budgetRemainingMs);
        chrome.alarms.create(`budget-end:${block.id}`, { when: now + rt.budgetRemainingMs });
      }
    }
    if (Number.isFinite(minRemaining) && minRemaining > 0) {
      chrome.alarms.create('usage-checkpoint', { when: now + Math.min(USAGE_SYNC_INTERVAL_MS, minRemaining) });
    }
  }
}

async function flushBudgetUsage(now = Date.now()) {
  await ensureUsageReady();
  if (!activeUsage || !activeUsage.url) return false;
  const elapsed = Math.max(0, now - activeUsage.startedAt);
  const trackedUrl = activeUsage.url;
  const startedAt = activeUsage.startedAt;
  activeUsage.startedAt = now;
  await saveActiveUsage();

  if (elapsed < 500) return false;

  const { config, runtime, blockStates } = await readState();
  const result = evaluate({ url: trackedUrl, now: startedAt, config, runtime, blockStates });
  if (result.verdict !== 'allow' || !result.budgetBlocks || result.budgetBlocks.length === 0) {
    return false;
  }

  let exhausted = false;
  for (const block of result.budgetBlocks) {
    const updated = await configStorage.updateBlockState(block.id, (current) => (
      addBlockUsage(block, current, elapsed, now)
    ));
    const rt = deriveBlockRuntime(block, updated, now);
    if (rt.state !== 'budget') exhausted = true;
  }
  return exhausted;
}

async function focusTabForUsage({ url, tabId, windowId, now = Date.now() }) {
  return serializeUsage(async () => {
    const exhausted = await flushBudgetUsage(now);
    const parsed = safeParseUrl(url);
    if (parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
      activeUsage = { url, tabId, windowId, startedAt: now };
    } else {
      activeUsage = null;
    }
    await saveActiveUsage();
    const { config, runtime, blockStates } = await readState();
    if (activeUsage) {
      scheduleBudgetAlarmsForUrl(activeUsage.url, config, runtime, blockStates, now);
    }
    if (exhausted) await sync();
  });
}

async function blurUsage(now = Date.now()) {
  return serializeUsage(async () => {
    const exhausted = await flushBudgetUsage(now);
    activeUsage = null;
    await saveActiveUsage();
    if (exhausted) await sync();
  });
}

async function checkpointUsage(now = Date.now()) {
  return serializeUsage(async () => {
    await ensureUsageReady();
    if (!activeUsage) return;
    let tab = null;
    try {
      [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    } catch {
      tab = null;
    }
    if (!tab || tab.id !== activeUsage.tabId || !tab.url || tab.url !== activeUsage.url) {
      const exhausted = await flushBudgetUsage(now);
      const parsed = tab && safeParseUrl(tab.url);
      if (parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
        activeUsage = { url: tab.url, tabId: tab.id, windowId: tab.windowId, startedAt: now };
      } else {
        activeUsage = null;
      }
      await saveActiveUsage();
      if (exhausted) await sync();
      return;
    }
    const exhausted = await flushBudgetUsage(now);
    const { config, runtime, blockStates } = await readState();
    scheduleBudgetAlarmsForUrl(activeUsage.url, config, runtime, blockStates, now);
    if (exhausted) await sync();
  });
}

async function sync() {
  if (syncing) {
    syncQueued = true;
    return;
  }
  syncing = true;
  try {
    const { config, blockStates: rawBlockStates, runtime: rawRuntime } = await readState();
    const now = Date.now();
    const { runtime, changes: rtChanges } = reconcile(rawRuntime, now);
    if (rtChanges.length > 0 || JSON.stringify(runtime) !== JSON.stringify(rawRuntime)) {
      await persistRuntime(runtime);
    }

    const { blockStates, changed: statesChanged } = reconcileBlockStates(config, rawBlockStates, now);
    if (statesChanged) {
      await configStorage.setBlockStates(blockStates);
    }

    const desired = buildRules({ config, runtime, blockStates, now, extensionId: chrome.runtime.id });
    const current = (await chrome.declarativeNetRequest.getDynamicRules()).map(sanitizeRule);
    const { removeRuleIds, addRules } = diffRules(current, desired);
    if (removeRuleIds.length > 0 || addRules.length > 0) {
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
      } catch (error) {
        console.error('Focus Guard: updating dynamic rules failed', error, { removeRuleIds, addRules });
      }
    }
    await ensureAlarms(config, runtime, blockStates, now);
    await convergeTabs(config, runtime, blockStates, now);
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

// --- Stats tracking ---

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

async function handleFocusTab(tabId, windowId) {
  const now = Date.now();
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    tab = null;
  }
  const url = tab ? tab.url : null;
  const { config } = await readState();
  if (tab && await enforceAntiUninstallOnTab(tabId, url, config, now)) {
    return;
  }

  await focusTabForUsage({ url, tabId, windowId, now });

  await ensureStatsReady();
  if (!statsEnabled) return;
  focusedWindowId = windowId;
  const hostname = httpHostname(url);
  const emissions = segmentTracker.handleFocus({ hostname, tabId, windowId, time: now });
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

function getNonPersistentScheduleEnd(config, now) {
  let maxEnd = null;
  for (const block of config.blocks || []) {
    if (!block.enabled || block.persistent) continue;
    if (!isScheduleActive(new Date(now), block.schedule)) continue;
    const end = scheduleBlockingEnd(new Date(now), block.schedule);
    const ts = end ? end.getTime() : now + 60 * 60 * 1000;
    if (!maxEnd || ts > maxEnd) maxEnd = ts;
  }
  return maxEnd;
}

function hasActiveNonPersistentScheduledBlock(config, now) {
  return (config.blocks || []).some(
    (b) => b.enabled && !b.persistent && isScheduleActive(new Date(now), b.schedule),
  );
}

async function handleMessage(msg) {
  switch (msg && msg.type) {
    case 'state:get': {
      await serializeUsage(() => flushBudgetUsage(Date.now()));
      const { config, blockStates, runtime } = await readState();
      return { ok: true, config, blockStates, runtime, now: Date.now() };
    }
    case 'config:save': {
      const { config: currentConfig } = await readState();
      const { config, errors } = normalizeConfig(msg.config);
      if (errors.length > 0) return { ok: false, errors };
      const now = Date.now();
      const lockCheck = validateLockedBlockChanges(currentConfig, config, now);
      if (!lockCheck.ok) return { ok: false, errors: lockCheck.errors };
      await configStorage.setConfig(config);
      await sync();
      return { ok: true, config };
    }
    case 'snooze:start': {
      const now = Date.now();
      const { config, runtime, blockStates } = await readState();
      const target = safeParseUrl(msg.targetUrl);
      if (!target) return { ok: false, error: 'Invalid target URL' };

      const result = evaluate({ url: msg.targetUrl, now, config, runtime, blockStates });
      if (result.verdict === 'allow') return { ok: true, verdict: 'allow' };
      if (result.verdict !== 'block-snoozable') {
        return { ok: false, verdict: result.verdict, error: 'Snooze is not available' };
      }

      const requestedIds = Array.isArray(msg.blockIds) && msg.blockIds.length > 0
        ? msg.blockIds
        : result.snoozableBlocks.map((b) => b.block.id);

      let latestEndsAt = 0;
      for (const blockId of requestedIds) {
        const block = config.blocks.find((b) => b.id === blockId);
        if (!block) return { ok: false, error: 'Block not found' };
        let activationError = null;
        const nextState = await configStorage.updateBlockState(blockId, (current) => {
          const res = activateBlockSnooze(block, current, now);
          if (!res.ok) {
            activationError = res.error;
            return current;
          }
          latestEndsAt = Math.max(latestEndsAt, res.snooze.endsAt);
          return res.state;
        });
        if (activationError) return { ok: false, error: activationError };
        if (nextState.snooze) latestEndsAt = Math.max(latestEndsAt, nextState.snooze.endsAt);
      }

      await sync();
      return { ok: true, endsAt: latestEndsAt };
    }
    case 'snooze:end': {
      const now = Date.now();
      if (!msg.blockId) return { ok: false, error: 'Missing blockId' };
      await configStorage.updateBlockState(msg.blockId, (current) => endBlockSnooze(current, now));
      await sync();
      return { ok: true };
    }
    case 'overlay:check': {
      await ensureUsageReady();
      const now = Date.now();
      const { config, runtime, blockStates } = await readState();
      // Account for unflushed live active-tab budget usage so countdown is accurate to the second
      const adjustedStates = { ...blockStates };
      if (activeUsage && activeUsage.url && activeUsage.startedAt < now) {
        const elapsed = now - activeUsage.startedAt;
        const pre = evaluate({ url: activeUsage.url, now: activeUsage.startedAt, config, runtime, blockStates });
        if (pre.verdict === 'allow' && pre.budgetBlocks) {
          for (const b of pre.budgetBlocks) {
            adjustedStates[b.id] = addBlockUsage(b, adjustedStates[b.id], elapsed, now);
          }
        }
      }
      const result = evaluate({ url: msg.url, now, config, runtime, blockStates: adjustedStates });
      const active = result.verdict === 'allow' && Boolean(result.activeTimer);
      return {
        ok: true,
        active,
        mode: active ? result.activeTimer.mode : null,
        blockId: active ? result.activeTimer.blockId : null,
        blockName: active ? result.activeTimer.blockName : null,
        remainingMs: active ? result.activeTimer.remainingMs : null,
        endsAt: active ? result.activeTimer.endsAt : null,
        verdict: result.verdict,
      };
    }
    case 'master:set': {
      const { config, runtime } = await readState();
      const now = Date.now();
      const hasNonPersistentScheduled = hasActiveNonPersistentScheduledBlock(config, now);
      if (!msg.enabled && hasNonPersistentScheduled && !(runtime.override && runtime.override.until > now)) {
        return { ok: false, error: 'confirmation-required' };
      }
      if (!msg.enabled && !hasNonPersistentScheduled && hasActivePersistentBlock(config, now) && !config.master.enabled) {
        return { ok: false, error: 'persistent-locked' };
      }
      if (msg.enabled && hasNonPersistentScheduled && runtime.override && runtime.override.until > now) {
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
      if (!hasActiveNonPersistentScheduledBlock(config, now)) {
        return { ok: false, error: 'No non-persistent scheduled blocks active' };
      }
      const until = getNonPersistentScheduleEnd(config, now) || (now + 60 * 60 * 1000);
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

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const name = alarm ? alarm.name : '';
  if (name === 'usage-checkpoint' || name.startsWith('budget-end:')) {
    await checkpointUsage();
  } else {
    await serializeUsage(() => flushBudgetUsage(Date.now()));
  }
  await statsTick();
  await sync();
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  handleFocusTab(tabId, windowId);
});

chrome.tabs.onCreated.addListener(async (tab) => {
  const url = tab.pendingUrl || tab.url;
  if (!url || !tab.id) return;
  const { config } = await readState();
  await enforceAntiUninstallOnTab(tab.id, url, config, Date.now());
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const url = changeInfo.url || (tab && tab.url);
  if (changeInfo.url) {
    const { config } = await readState();
    if (await enforceAntiUninstallOnTab(tabId, changeInfo.url, config, Date.now())) {
      return;
    }
  }
  if (!changeInfo.url) return;
  if (tab && tab.active && tab.windowId === focusedWindowId) {
    await focusTabForUsage({ url: changeInfo.url, tabId, windowId: tab.windowId, now: Date.now() });
  }
  await ensureStatsReady();
  if (!statsEnabled) return;
  if (!tab || !tab.active || tab.windowId !== focusedWindowId) return;
  const emissions = segmentTracker.handleFocus({ hostname: httpHostname(url), tabId, windowId: tab.windowId, time: Date.now() });
  await persistOpenSegment();
  await statsFlush(emissions);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  const time = Date.now();
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await blurUsage(time);
    await ensureStatsReady();
    focusedWindowId = windowId;
    if (!statsEnabled) return;
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
  if (tab) {
    const { config } = await readState();
    if (await enforceAntiUninstallOnTab(tab.id, tab.url, config, time)) {
      return;
    }
  }
  await focusTabForUsage({ url: tab ? tab.url : null, tabId: tab ? tab.id : null, windowId, now: time });

  await ensureStatsReady();
  focusedWindowId = windowId;
  if (!statsEnabled) return;
  const hostname = tab ? httpHostname(tab.url) : null;
  const emissions = segmentTracker.handleFocus({ hostname, tabId: tab ? tab.id : null, windowId, time });
  await persistOpenSegment();
  await statsFlush(emissions);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await serializeUsage(async () => {
    await ensureUsageReady();
    if (activeUsage && activeUsage.tabId === tabId) {
      const exhausted = await flushBudgetUsage(Date.now());
      activeUsage = null;
      await saveActiveUsage();
      if (exhausted) await sync();
    }
  });
  await ensureStatsReady();
  if (!statsEnabled) return;
  const emissions = segmentTracker.handleTabRemoved(tabId, Date.now());
  if (emissions.length === 0) return;
  await persistOpenSegment();
  await statsFlush(emissions);
});

async function onConfigChanged(nextConfig) {
  if (statsReadyPromise && nextConfig) {
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
  if (area === 'sync') {
    const keys = Object.keys(changes);
    const relevant = keys.some(
      (k) => k === CONFIG_KEY
        || k.startsWith(STORAGE_KEYS.BLOCK_PREFIX)
        || k.startsWith(STORAGE_KEYS.BLOCK_STATE_PREFIX),
    );
    if (relevant) {
      if (changes[CONFIG_KEY]) {
        const { config } = await readState();
        await onConfigChanged(config);
      } else {
        sync();
      }
    }
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
