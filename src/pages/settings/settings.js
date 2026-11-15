import {
  computeStatus,
  statusSummary,
  createReflectionModal,
  collectBlocksFromDom,
  escapeHtml,
} from './settings-logic.js';
import { buildStatsModel, statsTableHtml, formatHours } from './stats-logic.js';
import {
  normalizeConfig,
  defaultConfig,
  defaultBlock,
  newBlockId,
  newSiteId,
  isBlockLocked,
  hasActivePersistentBlock,
} from '../../lib/config.js';
import { isBlockActive } from '../../lib/decision.js';
import { deriveBlockRuntime } from '../../lib/sessions.js';
import { scheduleBlockingEnd, formatTime, DAY_LABELS } from '../../lib/schedule.js';
import { normalizeHostname, compilePathGlob } from '../../lib/patterns.js';
import { formatDuration, formatClockTime } from '../../lib/format.js';
import { WALLPAPERS } from '../../lib/wallpapers.js';
import { periodStart, dayKeysBetween } from '../../lib/dates.js';
import { createConfigStorage } from '../../lib/config-storage.js';
import { createStatsStorage } from '../../lib/stats-storage.js';
import { STORAGE_KEYS, STATS, STATS_PERIODS } from '../../lib/constants.js';

const storage = chrome.storage.local;
const statsStorage = createStatsStorage({ storage });
const configStorage = createConfigStorage({ sync: chrome.storage.sync, local: chrome.storage.local });

let config = defaultConfig();
let blockStates = {};
let runtime = { override: null };
let dirty = false;
let activeTab = 'blocks';
let statsPeriod = 'today';
let statsQuery = '';
let statsExpanded = new Set();

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response);
    });
  });
}

async function loadState() {
  const response = await sendMessage({ type: 'state:get' });
  if (response && response.ok && response.config) {
    config = normalizeConfig(response.config).config;
    blockStates = response.blockStates || {};
    runtime = response.runtime || { override: null };
    return;
  }
  const storedConfig = await configStorage.getConfig();
  config = storedConfig ? normalizeConfig(storedConfig).config : defaultConfig();
  blockStates = await configStorage.getBlockStates(config.blocks.map((b) => b.id));
  const store = await storage.get([STORAGE_KEYS.RUNTIME]);
  runtime = store[STORAGE_KEYS.RUNTIME] || { override: null };
}

function el(id) {
  return document.getElementById(id);
}

function renderAll() {
  renderStatus();
  renderProtection();
  renderBlocks();
  renderWallpaper();
  renderStatsSettings();
}

function activateTab(name) {
  if (!['blocks', 'wallpaper', 'stats'].includes(name)) name = 'blocks';
  activeTab = name;
  document.querySelectorAll('#tabs .tab').forEach((tab) => {
    tab.classList.toggle('on', tab.dataset.tab === name);
  });
  document.querySelectorAll('[data-tab-section]').forEach((section) => {
    section.hidden = section.dataset.tabSection !== name;
  });
  el('btn-save').parentElement.classList.toggle('hidden', name === 'stats' || name === 'wallpaper');
  if (location.hash !== `#${name}`) location.hash = name;
  if (name === 'stats') renderStats();
}

async function renderStats() {
  const buckets = await loadStatsBuckets(statsPeriod);
  const model = buildStatsModel(buckets, { query: statsQuery, config });
  model.domains = model.domains.map((d) => ({ ...d, expanded: statsExpanded.has(d.domain) }));
  el('stats-table').innerHTML = statsTableHtml(model);
  const summary = model.siteCount > 0
    ? `Tracked ${formatHours(model.totalSeconds)} · ${model.siteCount} ${model.siteCount === 1 ? 'site' : 'sites'} · ${model.totalVisits} ${model.totalVisits === 1 ? 'visit' : 'visits'}${statsQuery ? ' (filtered)' : ''}`
    : '';
  el('stats-summary').textContent = summary;
}

async function loadStatsBuckets(period) {
  if (period === 'all') return statsStorage.queryAll();
  const start = periodStart(period, new Date());
  const keys = dayKeysBetween(start, new Date());
  return statsStorage.queryDayKeys(keys);
}

function renderStatsSettings() {
  const stats = config.stats || { enabled: true, retentionMonths: 12 };
  el('stats-collect').checked = Boolean(stats.enabled);
  el('stats-retention').value = String(stats.retentionMonths);
}

function renderProtection() {
  const now = Date.now();
  const enabled = Boolean(config.antiUninstall && config.antiUninstall.enabled);
  const locked = enabled && hasActivePersistentBlock(config, now);
  const checkbox = el('anti-uninstall-enabled');
  checkbox.checked = enabled;
  checkbox.disabled = locked;
  el('anti-uninstall-lock').classList.toggle('hidden', !locked);
}

function renderStatus() {
  const now = Date.now();
  const status = computeStatus(config, runtime, now, blockStates);
  const summary = statusSummary(status);

  const toggle = el('master-toggle');
  toggle.classList.toggle('on', status.blockingActive);
  toggle.setAttribute('aria-checked', String(status.blockingActive));
  el('master-label').textContent = status.blockingActive ? 'Blocking on' : 'Blocking off';

  el('status-title').textContent = summary.title;
  el('status-subtitle').textContent = summary.subtitle;

  const tiles = [];

  tiles.push(`
    <div class="status-tile">
      <div class="label">Active blocks</div>
      <div class="value">${status.activeBlockCount} of ${config.blocks.length}${status.hasLockedBlock ? ` (${status.lockedBlockCount} locked)` : ''}</div>
    </div>`);

  tiles.push(`
    <div class="status-tile">
      <div class="label">Next schedule change</div>
      <div class="value">${status.nextChange
    ? `${DAY_LABELS[status.nextChange.getDay()].slice(0, 3)} ${formatClockTime(status.nextChange)}`
    : 'no schedule set'}</div>
    </div>`);

  tiles.push(`
    <div class="status-tile">
      <div class="label">Master switch</div>
      <div class="value">${status.masterEnabled ? 'on (outside hours)' : 'off'}</div>
    </div>`);

  for (const snooze of status.activeSnoozes) {
    tiles.push(`
      <div class="status-tile">
        <div class="label">Snooze — ${escapeHtml(snooze.blockName)}</div>
        <div class="value ok">${formatDuration(snooze.remainingMs)} left</div>
      </div>`);
  }
  for (const budget of status.activeBudgets) {
    tiles.push(`
      <div class="status-tile">
        <div class="label">Time budget — ${escapeHtml(budget.blockName)}</div>
        <div class="value">${formatDuration(budget.remainingMs)} left</div>
      </div>`);
  }

  el('status-extra').innerHTML = tiles.join('');
}

function chipHtml(kind, value, disabledAttr) {
  return `<span class="chip" data-kind="${kind}" data-value="${escapeHtml(value)}">${escapeHtml(value)}<button type="button" data-action="remove-chip" title="Remove" ${disabledAttr}>×</button></span>`;
}

function siteCardHtml(site, disabledAttr) {
  const domain = escapeHtml(site.domain);
  const subdomainChips = (site.subdomains || []).map((s) => chipHtml('subdomain', s, disabledAttr)).join('');
  const whitelistChips = (site.whitelist || []).map((w) => chipHtml('whitelist', w, disabledAttr)).join('');
  return `
    <div class="site-card" data-site-id="${escapeHtml(site.id)}">
      <div class="site-head">
        <input type="text" class="site-domain" value="${domain}" placeholder="domain.com" spellcheck="false" autocomplete="off" ${disabledAttr}>
        <button type="button" class="btn btn-small btn-danger" data-action="remove-site" ${disabledAttr}>Remove</button>
      </div>
      <div class="group-options">
        <label class="check-row">
          <input type="checkbox" class="site-include-base" ${site.includeBaseHost ? 'checked' : ''} ${disabledAttr}>
          <span>Block <code>${domain || 'domain'}</code> itself <span class="muted">— exact host, www twin included</span></span>
        </label>
        <label class="check-row">
          <input type="checkbox" class="site-include-subdomains" ${site.includeAllSubdomains ? 'checked' : ''} ${disabledAttr}>
          <span>All subdomains <span class="muted">— <code>*.${domain || 'domain'}</code></span></span>
        </label>
      </div>
      <div class="chip-section">
        <label>Specific subdomains</label>
        <div class="chips">
          ${subdomainChips}
          <input type="text" class="chip-input" data-chip-kind="subdomain" placeholder="old.${domain || 'domain'}" spellcheck="false" autocomplete="off" ${disabledAttr}>
          <button type="button" class="btn chip-add" data-action="add-chip" ${disabledAttr}>Add</button>
        </div>
      </div>
      <div class="chip-section">
        <label>Whitelisted paths — always allowed</label>
        <div class="chips">
          ${whitelistChips}
          <input type="text" class="chip-input" data-chip-kind="whitelist" placeholder="/r/learn* or paste a URL" spellcheck="false" autocomplete="off" ${disabledAttr}>
          <button type="button" class="btn chip-add" data-action="add-chip" ${disabledAttr}>Add</button>
        </div>
      </div>
    </div>`;
}

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function windowRowHtml(win, disabledAttr) {
  const days = Array.isArray(win.days) ? win.days : [1, 2, 3, 4, 5];
  const start = typeof win.start === 'number' ? formatTime(win.start) : (win.start || '09:00');
  const end = typeof win.end === 'number' ? formatTime(win.end) : (win.end || '17:00');
  const dayPills = DAY_ORDER.map((d) => {
    const on = days.includes(d) ? 'on' : '';
    const label = DAY_LABELS[d].slice(0, 3);
    return `<button type="button" class="day-pill ${on}" data-action="toggle-day" data-day="${d}" ${disabledAttr}>${label}</button>`;
  }).join('');
  return `
    <div class="window-row">
      <div class="day-pills">${dayPills}</div>
      <div class="schedule-range">
        <input type="time" class="range-start" value="${escapeHtml(start)}" ${disabledAttr}>
        <span class="muted">→</span>
        <input type="time" class="range-end" value="${escapeHtml(end)}" ${disabledAttr}>
        <button type="button" class="range-remove" data-action="remove-window" title="Remove window" ${disabledAttr}>×</button>
      </div>
    </div>`;
}

function runtimeSummaryForBlock(block, rt) {
  const parts = [];
  if (block.timeLimit && block.timeLimit.enabled) {
    if (rt.state === 'budget') {
      parts.push(`Time budget: ${formatDuration(rt.budgetRemainingMs)} left`);
    } else if (rt.budgetResetAt) {
      parts.push(`Time budget used (resets at ${formatClockTime(new Date(rt.budgetResetAt))})`);
    } else {
      parts.push(`Time budget: ${block.timeLimit.minutes}m / ${block.timeLimit.periodHours}h ready`);
    }
  }
  if (block.snooze && block.snooze.enabled) {
    if (rt.state === 'snooze') {
      parts.push(`Snooze active: ${formatDuration(rt.remainingMs)} left`);
    } else {
      parts.push(`Snoozes: ${rt.snoozesLeft}/${rt.snoozeMax} available`);
    }
  }
  return parts.join(' · ');
}

function blockHtml(block, now) {
  const locked = isBlockLocked(block, now);
  const active = isBlockActive(block, now, config, runtime);
  const disabledAttr = locked ? 'disabled' : '';
  const rt = deriveBlockRuntime(block, blockStates[block.id], now);
  const end = locked ? scheduleBlockingEnd(new Date(now), block.schedule) : null;

  let badgeText = 'Inactive';
  let badgeClass = '';
  if (locked) {
    badgeText = end ? `Locked until ${formatClockTime(end)}` : 'Locked 24/7';
    badgeClass = 'locked';
  } else if (active) {
    badgeText = 'Active';
    badgeClass = 'active';
  } else if (!block.enabled) {
    badgeText = 'Disabled';
  }

  const sitesHtml = (block.sites || []).map((s) => siteCardHtml(s, disabledAttr)).join('');
  const alwaysActive = Boolean(block.schedule && block.schedule.alwaysActive);
  const windowsHtml = ((block.schedule && block.schedule.windows) || [])
    .map((w) => windowRowHtml(w, disabledAttr))
    .join('');

  const tl = block.timeLimit || { enabled: false, minutes: 20, periodHours: 8 };
  const sn = block.snooze || { enabled: false, durationMinutes: 5, maxCount: 1, periodHours: 4 };
  const rtSummary = runtimeSummaryForBlock(block, rt);

  return `
    <div class="block-card ${locked ? 'locked' : ''}" data-block-id="${escapeHtml(block.id)}">
      <div class="block-head">
        <div class="block-title-row">
          <input type="text" class="block-name" value="${escapeHtml(block.name)}" placeholder="Block name" maxlength="60" ${disabledAttr}>
          <span class="block-status-badge ${badgeClass}">${escapeHtml(badgeText)}</span>
        </div>
        <div class="block-controls">
          <label class="check-row">
            <input type="checkbox" class="block-enabled" ${block.enabled ? 'checked' : ''} ${disabledAttr}>
            <span>Enabled</span>
          </label>
          <label class="check-row" title="Cannot be edited, disabled, or deleted while active during scheduled hours">
            <input type="checkbox" class="block-persistent" ${block.persistent ? 'checked' : ''} ${disabledAttr}>
            <span>Persistent mode</span>
          </label>
          <button type="button" class="btn btn-small btn-danger" data-action="delete-block" ${disabledAttr}>Delete</button>
        </div>
      </div>

      ${rtSummary ? `<div class="block-runtime-bar">${escapeHtml(rtSummary)}</div>` : ''}

      <div class="block-subsection">
        <div class="block-subsection-head">
          <h3>Websites (${(block.sites || []).length})</h3>
          <div class="add-domain">
            <input type="text" class="new-site-domain" placeholder="example.com" spellcheck="false" autocomplete="off" ${disabledAttr}>
            <button type="button" class="btn btn-small btn-primary" data-action="add-site" ${disabledAttr}>Add site</button>
          </div>
        </div>
        <div class="sites-list">${sitesHtml}</div>
        <p class="muted small sites-empty ${(block.sites || []).length > 0 ? 'hidden' : ''}">No websites in this block yet.</p>
      </div>

      <div class="block-subsection">
        <div class="block-subsection-head">
          <h3>Schedule</h3>
          <label class="check-row">
            <input type="checkbox" class="block-always-active" ${alwaysActive ? 'checked' : ''} ${disabledAttr}>
            <span>24/7 (Always active)</span>
          </label>
        </div>
        <div class="windows-list ${alwaysActive ? 'hidden' : ''}">
          ${windowsHtml}
        </div>
        <div class="${alwaysActive ? 'hidden' : ''}">
          <button type="button" class="btn btn-small range-add" data-action="add-window" ${disabledAttr}>+ Add time window</button>
        </div>
      </div>

      <div class="block-subsection">
        <h3>Time limit &amp; Snooze</h3>
        <div class="rules-grid">
          <div class="rule-row">
            <label class="check-row">
              <input type="checkbox" class="limit-enabled" ${tl.enabled ? 'checked' : ''} ${disabledAttr}>
              <span>Global time limit <span class="muted">— total active browsing time shared across all sites in this block</span></span>
            </label>
            <div class="rule-inputs">
              <span>Allow</span>
              <input type="number" class="num-input limit-minutes" min="1" max="1440" step="1" value="${tl.minutes}" ${locked || !tl.enabled ? 'disabled' : ''}>
              <span>minutes every</span>
              <input type="number" class="num-input limit-hours" min="0.5" max="168" step="0.5" value="${tl.periodHours}" ${locked || !tl.enabled ? 'disabled' : ''}>
              <span>hours</span>
            </div>
          </div>
          <div class="rule-row">
            <label class="check-row">
              <input type="checkbox" class="snooze-enabled" ${sn.enabled ? 'checked' : ''} ${disabledAttr}>
              <span>Snooze <span class="muted">— temporary bypass (continuous wall-clock time from activation)</span></span>
            </label>
            <div class="rule-inputs">
              <span>Duration</span>
              <input type="number" class="num-input snooze-duration" min="1" max="180" step="1" value="${sn.durationMinutes}" ${locked || !sn.enabled ? 'disabled' : ''}>
              <span>min · max</span>
              <input type="number" class="num-input snooze-max" min="1" max="100" step="1" value="${sn.maxCount}" ${locked || !sn.enabled ? 'disabled' : ''}>
              <span>every</span>
              <input type="number" class="num-input snooze-hours" min="0.5" max="168" step="0.5" value="${sn.periodHours}" ${locked || !sn.enabled ? 'disabled' : ''}>
              <span>hours</span>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

function renderBlocks() {
  const now = Date.now();
  const list = el('blocks-list');
  list.innerHTML = (config.blocks || []).map((b) => blockHtml(b, now)).join('');
  el('blocks-empty').classList.toggle('hidden', (config.blocks || []).length > 0);
}

function renderWallpaper() {
  const current = config.wallpaper || { mode: 'builtin', value: 'aurora' };
  el('wallpaper-grid').innerHTML = WALLPAPERS.map((wp) => `
    <div class="wallpaper-option ${current.mode === 'builtin' && current.value === wp.id ? 'on' : ''}" data-wallpaper="${wp.id}">
      <img src="${chrome.runtime.getURL(wp.file)}" alt="${wp.name}">
      <span class="name">${wp.name}</span>
    </div>`).join('');
  if (current.mode === 'url') {
    el('custom-wallpaper-url').value = current.value;
  }
}

function markDirty() {
  dirty = true;
  el('save-status').textContent = 'Unsaved changes';
  el('save-status').className = 'muted';
}

function showStatus(message, className = 'save-error') {
  el('save-status').textContent = message;
  el('save-status').className = className;
}

async function persistConfig(nextConfig) {
  const { config: normalized, errors } = normalizeConfig(nextConfig);
  if (errors.length > 0) return { ok: false, errors };
  const response = await sendMessage({ type: 'config:save', config: normalized });
  if (!response || !response.ok) {
    return { ok: false, errors: (response && response.errors) || ['Could not save configuration'] };
  }
  config = response.config;
  return { ok: true };
}

function collectDraft() {
  const { blocks, scheduleErrors } = collectBlocksFromDom(
    [...document.querySelectorAll('.block-card')],
    { makeBlockId: newBlockId, makeSiteId: newSiteId },
  );
  const antiUninstall = { enabled: Boolean(el('anti-uninstall-enabled').checked) };
  return {
    config: { ...config, antiUninstall, blocks },
    scheduleErrors,
  };
}

async function saveAll() {
  const draft = collectDraft();
  if (draft.scheduleErrors.length > 0) {
    showStatus(draft.scheduleErrors[0].message);
    return;
  }
  const result = await persistConfig(draft.config);
  if (!result.ok) {
    showStatus(result.errors[0] || 'Could not save');
    return;
  }
  dirty = false;
  showStatus('Saved — synced across devices', 'save-ok');
  await loadState();
  renderAll();
}

function addSiteToBlockCard(card) {
  if (!card || card.classList.contains('locked')) return;
  const input = card.querySelector('.new-site-domain');
  const raw = input ? input.value.trim() : '';
  if (!raw) return;
  const parsed = normalizeHostname(raw);
  if (!parsed.ok) {
    showStatus(`"${raw}" is not a valid host — ${parsed.error}`);
    return;
  }
  const domain = parsed.hostname;
  const existing = [...card.querySelectorAll('.site-domain')].some((elDomain) => {
    const res = normalizeHostname(elDomain.value);
    return res.ok ? res.hostname === domain : elDomain.value.trim() === domain;
  });
  if (existing) {
    showStatus(`${domain} is already in this block`);
    return;
  }
  const site = {
    id: newSiteId(),
    domain,
    includeBaseHost: true,
    includeAllSubdomains: false,
    subdomains: [],
    whitelist: [],
  };
  card.querySelector('.sites-list').insertAdjacentHTML('beforeend', siteCardHtml(site, ''));
  card.querySelector('.sites-empty').classList.add('hidden');
  updateSiteCountHeading(card);
  input.value = '';
  markDirty();
  showStatus(`Added ${domain} (unsaved)`, 'save-ok');
}

function updateSiteCountHeading(card) {
  const count = card.querySelectorAll('.site-card').length;
  const heading = card.querySelector('.block-subsection h3');
  if (heading && heading.textContent.startsWith('Websites')) {
    heading.textContent = `Websites (${count})`;
  }
  const emptyHint = card.querySelector('.sites-empty');
  if (emptyHint) emptyHint.classList.toggle('hidden', count > 0);
}

async function onQuickBlock(domain) {
  const parsed = normalizeHostname(domain);
  const host = parsed.ok ? parsed.hostname : domain;
  const draft = collectDraft();
  const alreadyBlocked = draft.config.blocks.some((b) => (b.sites || []).some((s) => {
    const existing = normalizeHostname(s.domain);
    return existing.ok ? existing.hostname === host : s.domain === host;
  }));
  if (alreadyBlocked) {
    activateTab('blocks');
    return;
  }

  const now = Date.now();
  let targetBlock = draft.config.blocks.find((b) => !isBlockLocked(b, now));
  if (!targetBlock) {
    targetBlock = defaultBlock(draft.config.blocks.length);
    draft.config.blocks.push(targetBlock);
  }
  targetBlock.sites.push({
    id: newSiteId(),
    domain: host,
    includeBaseHost: true,
    includeAllSubdomains: false,
    subdomains: [],
    whitelist: [],
  });
  config = draft.config;
  renderBlocks();
  markDirty();
  activateTab('blocks');
  const card = document.querySelector(`.block-card[data-block-id="${targetBlock.id}"]`);
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('flash');
    setTimeout(() => card.classList.remove('flash'), 1600);
  }
}

async function onMasterToggle() {
  const status = computeStatus(config, runtime, Date.now(), blockStates);
  if (!status.blockingActive) {
    if (status.hasNonPersistentScheduled && status.overrideActive) {
      await sendMessage({ type: 'override:clear' });
    } else {
      await sendMessage({ type: 'master:set', enabled: true });
    }
    await loadState();
    renderStatus();
    renderBlocks();
    return;
  }
  if (status.hasNonPersistentScheduled && !status.overrideActive) {
    createReflectionModal({
      document,
      onConfirm: async () => {
        await sendMessage({ type: 'override:off' });
        await loadState();
        renderStatus();
        renderBlocks();
      },
      onCancel: () => renderStatus(),
    });
    return;
  }
  const res = await sendMessage({ type: 'master:set', enabled: false });
  if (res && !res.ok && res.error === 'persistent-locked') {
    showStatus('Active persistent blocks cannot be turned off during scheduled hours');
    return;
  }
  await loadState();
  renderStatus();
  renderBlocks();
}

function addChipFromInput(input) {
  if (!input) return;
  const raw = input.value.trim();
  if (!raw) return;
  const kind = input.dataset.chipKind;
  let value = raw;

  if (kind === 'subdomain') {
    const parsed = normalizeHostname(raw);
    if (!parsed.ok) {
      showStatus(`"${raw}" is not a valid host — ${parsed.error}`);
      return;
    }
    value = parsed.hostname;
    const siteCard = input.closest('.site-card');
    const domainInput = siteCard && siteCard.querySelector('.site-domain');
    const siteDomain = domainInput ? normalizeHostname(domainInput.value) : null;
    if (siteDomain && siteDomain.ok && siteDomain.hostname === value) {
      showStatus(`${value} is already covered by this site's host`);
      return;
    }
  } else if (kind === 'whitelist') {
    const parsed = compilePathGlob(raw);
    if (!parsed.ok) {
      showStatus(`"${raw}" is not a valid path — ${parsed.error}`);
      return;
    }
    value = parsed.normalized;
  }

  const chips = input.parentElement.querySelectorAll(`.chip[data-kind="${kind}"]`);
  for (const chip of chips) {
    if (chip.dataset.value === value) {
      input.value = '';
      return;
    }
  }
  input.insertAdjacentHTML('beforebegin', chipHtml(kind, value, ''));
  input.value = '';
  markDirty();
}

function wireEvents() {
  el('tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (tab) activateTab(tab.dataset.tab);
  });

  el('stats-periods').addEventListener('click', (event) => {
    const pill = event.target.closest('.tabpill');
    if (!pill) return;
    statsPeriod = STATS_PERIODS.includes(pill.dataset.period) ? pill.dataset.period : 'today';
    document.querySelectorAll('#stats-periods .tabpill').forEach((p) => {
      p.classList.toggle('on', p === pill);
    });
    renderStats();
  });

  el('stats-search').addEventListener('input', (event) => {
    statsQuery = event.target.value.trim();
    renderStats();
  });

  el('stats-table').addEventListener('click', async (event) => {
    const expander = event.target.closest('[data-expand]');
    if (expander) {
      const domain = expander.dataset.expand;
      if (statsExpanded.has(domain)) statsExpanded.delete(domain);
      else statsExpanded.add(domain);
      renderStats();
      return;
    }
    const blockButton = event.target.closest('[data-block-domain]');
    if (blockButton) {
      await onQuickBlock(blockButton.dataset.blockDomain);
    }
  });

  el('btn-clear-stats').addEventListener('click', async () => {
    if (!window.confirm('Delete all tracked browsing stats? This cannot be undone.')) return;
    await statsStorage.clear();
    renderStats();
  });

  el('stats-collect').addEventListener('change', async (event) => {
    const result = await persistConfig({ ...config, stats: { ...config.stats, enabled: event.target.checked } });
    if (result.ok) renderStatsSettings();
  });

  el('stats-retention').addEventListener('change', async (event) => {
    const result = await persistConfig({ ...config, stats: { ...config.stats, retentionMonths: Number(event.target.value) } });
    if (result.ok) renderStatsSettings();
  });

  el('anti-uninstall-enabled').addEventListener('change', markDirty);

  el('btn-add-block').addEventListener('click', () => {
    const draft = collectDraft();
    const next = defaultBlock(draft.config.blocks.length);
    draft.config.blocks.push(next);
    config = draft.config;
    renderBlocks();
    markDirty();
    const card = document.querySelector(`.block-card[data-block-id="${next.id}"]`);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  el('master-toggle').addEventListener('click', onMasterToggle);

  el('blocks-list').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    const card = button.closest('.block-card');
    if (!card) return;
    const action = button.dataset.action;

    if (action === 'delete-block') {
      if (card.classList.contains('locked')) return;
      card.remove();
      el('blocks-empty').classList.toggle('hidden', document.querySelectorAll('.block-card').length > 0);
      markDirty();
    } else if (action === 'add-site') {
      addSiteToBlockCard(card);
    } else if (action === 'remove-site') {
      button.closest('.site-card').remove();
      updateSiteCountHeading(card);
      markDirty();
    } else if (action === 'remove-chip') {
      button.closest('.chip').remove();
      markDirty();
    } else if (action === 'add-chip') {
      const input = button.parentElement.querySelector('.chip-input');
      addChipFromInput(input);
    } else if (action === 'add-window') {
      const list = card.querySelector('.windows-list');
      list.insertAdjacentHTML('beforeend', windowRowHtml({ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }, ''));
      markDirty();
    } else if (action === 'remove-window') {
      button.closest('.window-row').remove();
      markDirty();
    } else if (action === 'toggle-day') {
      button.classList.toggle('on');
      markDirty();
    }
  });

  el('blocks-list').addEventListener('change', (event) => {
    const target = event.target;
    const card = target.closest('.block-card');
    if (!card) return;

    if (target.classList.contains('block-always-active')) {
      const hideWindows = target.checked;
      card.querySelector('.windows-list').classList.toggle('hidden', hideWindows);
      card.querySelector('[data-action="add-window"]').parentElement.classList.toggle('hidden', hideWindows);
    } else if (target.classList.contains('limit-enabled')) {
      const on = target.checked;
      card.querySelector('.limit-minutes').disabled = !on;
      card.querySelector('.limit-hours').disabled = !on;
    } else if (target.classList.contains('snooze-enabled')) {
      const on = target.checked;
      card.querySelector('.snooze-duration').disabled = !on;
      card.querySelector('.snooze-max').disabled = !on;
      card.querySelector('.snooze-hours').disabled = !on;
    }
    markDirty();
  });

  el('blocks-list').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    if (event.target.classList.contains('new-site-domain')) {
      event.preventDefault();
      addSiteToBlockCard(event.target.closest('.block-card'));
    } else if (event.target.classList.contains('chip-input')) {
      event.preventDefault();
      addChipFromInput(event.target);
    }
  });

  el('blocks-list').addEventListener('input', (event) => {
    if (!event.target.classList.contains('new-site-domain') && !event.target.classList.contains('chip-input')) {
      markDirty();
    }
  });

  el('btn-save').addEventListener('click', saveAll);

  el('wallpaper-grid').addEventListener('click', async (event) => {
    const option = event.target.closest('.wallpaper-option');
    if (!option) return;
    const next = { mode: 'builtin', value: option.dataset.wallpaper };
    const result = await persistConfig({ ...config, wallpaper: next });
    if (result.ok) {
      renderWallpaper();
      renderStatus();
    }
  });

  el('btn-custom-wallpaper').addEventListener('click', async () => {
    const value = el('custom-wallpaper-url').value.trim();
    if (!/^https?:\/\//.test(value)) {
      showStatus('Wallpaper URL must start with http(s)://');
      return;
    }
    const result = await persistConfig({ ...config, wallpaper: { mode: 'url', value } });
    if (result.ok) {
      renderWallpaper();
      renderStatus();
    } else {
      showStatus(result.errors[0]);
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (dirty) event.preventDefault();
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === 'sync') {
      const keys = Object.keys(changes);
      const configChanged = keys.some((k) => k === STORAGE_KEYS.CONFIG || k.startsWith(STORAGE_KEYS.BLOCK_PREFIX));
      const stateChanged = keys.some((k) => k.startsWith(STORAGE_KEYS.BLOCK_STATE_PREFIX));
      if (!configChanged && !stateChanged) return;
      if (dirty && configChanged) return;
      await loadState();
      renderStatus();
      renderProtection();
      if (!dirty) renderBlocks();
      if (configChanged) {
        renderWallpaper();
        renderStatsSettings();
      }
      return;
    }
    if (area !== 'local') return;
    if (changes[STORAGE_KEYS.RUNTIME]) {
      await loadState();
      renderStatus();
      if (!dirty) renderBlocks();
    }
    const statsChanged = Object.keys(changes).some((key) => key.startsWith(STATS.DAY_KEY_PREFIX));
    if (statsChanged && activeTab === 'stats') {
      renderStats();
    }
  });
}

async function init() {
  await loadState();
  renderAll();
  wireEvents();
  activateTab((location.hash || '#blocks').slice(1));
  setInterval(renderStatus, 1000);
  setInterval(() => {
    if (activeTab === 'stats') renderStats();
  }, 60000);
}

init();
