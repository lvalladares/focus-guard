import {
  computeStatus,
  statusSummary,
  createReflectionModal,
  collectGroupsFromDom,
  collectScheduleFromDom,
  escapeHtml,
} from './settings-logic.js';
import { normalizeConfig, defaultConfig, newGroupId } from '../../lib/config.js';
import { formatDuration, formatClockTime } from '../../lib/format.js';
import { WALLPAPERS } from '../../lib/wallpapers.js';
import { formatTime, DAY_LABELS } from '../../lib/schedule.js';
import { STORAGE_KEYS } from '../../lib/constants.js';

const storage = chrome.storage.local;

let config = defaultConfig();
let runtime = { sessions: {}, cooldowns: {}, override: null };
let dirty = false;

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
  const store = await storage.get([STORAGE_KEYS.CONFIG, STORAGE_KEYS.RUNTIME]);
  config = store[STORAGE_KEYS.CONFIG] || defaultConfig();
  runtime = store[STORAGE_KEYS.RUNTIME] || { sessions: {}, cooldowns: {}, override: null };
}

function el(id) {
  return document.getElementById(id);
}

function renderAll() {
  renderStatus();
  renderGroups();
  renderSchedule();
  renderWallpaper();
}

function renderStatus() {
  const now = Date.now();
  const status = computeStatus(config, runtime, now);
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
      <div class="label">Focus window</div>
      <div class="value">${status.inSchedule
    ? (status.windowEnd ? `until ${formatClockTime(status.windowEnd)}` : 'active')
    : 'outside hours'}</div>
    </div>`);

  tiles.push(`
    <div class="status-tile">
      <div class="label">Next change</div>
      <div class="value">${status.nextChange
    ? `${DAY_LABELS[status.nextChange.getDay()].slice(0, 3)} ${formatClockTime(status.nextChange)}`
    : 'no schedule set'}</div>
    </div>`);

  tiles.push(`
    <div class="status-tile">
      <div class="label">Master switch</div>
      <div class="value">${status.masterEnabled ? 'on (outside hours)' : 'off'}</div>
    </div>`);

  for (const session of status.activeSessions) {
    tiles.push(`
      <div class="status-tile">
        <div class="label">Dose — ${escapeHtml(session.domain)}</div>
        <div class="value ok">${formatDuration(session.remainingMs)} left</div>
      </div>`);
  }
  for (const cooldown of status.cooldowns) {
    tiles.push(`
      <div class="status-tile">
        <div class="label">Cooldown — ${escapeHtml(cooldown.domain)}</div>
        <div class="value off">${formatDuration(cooldown.remainingMs)}</div>
      </div>`);
  }

  el('status-extra').innerHTML = tiles.join('');
}

function chipHtml(kind, value) {
  return `<span class="chip" data-kind="${kind}" data-value="${escapeHtml(value)}">${escapeHtml(value)}<button type="button" data-action="remove-chip" title="Remove">×</button></span>`;
}

function groupHtml(group) {
  const domain = escapeHtml(group.domain);
  const subdomainChips = (group.subdomains || []).map((s) => chipHtml('subdomain', s)).join('');
  const whitelistChips = (group.whitelist || []).map((w) => chipHtml('whitelist', w)).join('');
  return `
    <div class="group" data-group-id="${escapeHtml(group.id)}">
      <div class="group-head">
        <input type="text" class="group-domain" value="${domain}" placeholder="domain.com" spellcheck="false" autocomplete="off">
        <div class="group-level">
          <button type="button" class="level-pill ${group.level === 'total' ? 'on' : ''}" data-level="total">Total block</button>
          <button type="button" class="level-pill ${group.level === 'partial' ? 'on' : ''}" data-level="partial">Partial (doses)</button>
        </div>
      </div>
      <div class="group-options">
        <label class="check-row">
          <input type="checkbox" class="group-include-base" ${group.includeBaseHost ? 'checked' : ''}>
          <span>Block <code>${domain || 'domain'}</code> itself <span class="muted">— exact host only</span></span>
        </label>
        <label class="check-row">
          <input type="checkbox" class="group-include-subdomains" ${group.includeAllSubdomains ? 'checked' : ''}>
          <span>All subdomains <span class="muted">— <code>*.${domain || 'domain'}</code></span></span>
        </label>
      </div>
      <div class="chip-section">
        <label>Specific subdomains</label>
        <div class="chips">
          ${subdomainChips}
          <input type="text" class="chip-input" data-chip-kind="subdomain" placeholder="old.${domain || 'domain'}" spellcheck="false" autocomplete="off">
          <button type="button" class="btn chip-add" data-action="add-chip">Add</button>
        </div>
      </div>
      <div class="chip-section">
        <label>Whitelisted paths — always allowed</label>
        <div class="chips">
          ${whitelistChips}
          <input type="text" class="chip-input" data-chip-kind="whitelist" placeholder="/r/learn*" spellcheck="false" autocomplete="off">
          <button type="button" class="btn chip-add" data-action="add-chip">Add</button>
        </div>
      </div>
      <div class="group-foot">
        <span class="muted small">Changes apply after saving</span>
        <button type="button" class="btn btn-danger" data-action="delete-group">Delete</button>
      </div>
    </div>`;
}

function renderGroups() {
  const list = el('groups-list');
  list.innerHTML = (config.groups || []).map(groupHtml).join('');
  el('groups-empty').classList.toggle('hidden', (config.groups || []).length > 0);
}

function scheduleRangeHtml(start, end) {
  return `
    <div class="schedule-range">
      <input type="time" class="range-start" value="${start}">
      <span class="muted">→</span>
      <input type="time" class="range-end" value="${end}">
      <button type="button" class="range-remove" data-action="remove-range" title="Remove range">×</button>
    </div>`;
}

function renderSchedule() {
  const order = [1, 2, 3, 4, 5, 6, 0];
  const windows = (config.schedule && config.schedule.windows) || [];
  el('schedule-editor').innerHTML = order.map((day) => {
    const ranges = windows
      .filter((w) => w.days.includes(day))
      .map((w) => scheduleRangeHtml(formatTime(w.start), formatTime(w.end)))
      .join('');
    return `
      <div class="day-row" data-day="${day}">
        <div class="day-name">${DAY_LABELS[day]}</div>
        <div class="day-ranges">
          ${ranges || '<span class="muted small">No focus window</span>'}
          <button type="button" class="btn range-add" data-action="add-range">+ Add range</button>
        </div>
      </div>`;
  }).join('');
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
  const groups = collectGroupsFromDom([...document.querySelectorAll('.group')], newGroupId);
  const { windows, errors } = collectScheduleFromDom([...document.querySelectorAll('.day-row')]);
  return {
    config: { ...config, groups, schedule: { windows } },
    scheduleErrors: errors,
  };
}

async function saveAll() {
  const statusEl = el('save-status');
  const draft = collectDraft();
  if (draft.scheduleErrors.length > 0) {
    statusEl.textContent = draft.scheduleErrors[0].message;
    statusEl.className = 'save-error';
    return;
  }
  const result = await persistConfig(draft.config);
  if (!result.ok) {
    statusEl.textContent = result.errors[0] || 'Could not save';
    statusEl.className = 'save-error';
    return;
  }
  dirty = false;
  statusEl.textContent = 'Saved — stay awesome';
  statusEl.className = 'save-ok';
  renderGroups();
  renderSchedule();
  renderStatus();
}

async function onAddDomain() {
  const input = el('new-domain');
  const value = input.value.trim();
  if (!value) return;
  const draft = collectDraft();
  draft.config.groups.push({
    id: newGroupId(),
    domain: value,
    includeBaseHost: true,
    includeAllSubdomains: false,
    subdomains: [],
    whitelist: [],
    level: 'total',
  });
  config = draft.config;
  input.value = '';
  renderGroups();
  markDirty();
}

async function onMasterToggle() {
  const status = computeStatus(config, runtime, Date.now());
  if (!status.blockingActive) {
    if (status.inSchedule && status.overrideActive) {
      await sendMessage({ type: 'override:clear' });
    } else {
      await sendMessage({ type: 'master:set', enabled: true });
    }
    await loadState();
    renderStatus();
    return;
  }
  if (status.inSchedule && !status.overrideActive) {
    createReflectionModal({
      document,
      onConfirm: async () => {
        await sendMessage({ type: 'override:off' });
        await loadState();
        renderStatus();
      },
      onCancel: () => renderStatus(),
    });
    return;
  }
  await sendMessage({ type: 'master:set', enabled: false });
  await loadState();
  renderStatus();
}

function wireEvents() {
  el('btn-add-domain').addEventListener('click', onAddDomain);
  el('new-domain').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') onAddDomain();
  });

  el('master-toggle').addEventListener('click', onMasterToggle);

  el('groups-list').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'remove-chip') {
      button.closest('.chip').remove();
      markDirty();
    } else if (action === 'add-chip') {
      const input = button.parentElement.querySelector('.chip-input');
      addChipFromInput(input);
    } else if (action === 'delete-group') {
      const card = button.closest('.group');
      card.remove();
      el('groups-empty').classList.toggle('hidden', document.querySelectorAll('.group').length > 0);
      markDirty();
    } else if (button.dataset.level) {
      const card = button.closest('.group');
      card.querySelectorAll('.level-pill').forEach((pill) => {
        pill.classList.toggle('on', pill === button);
      });
      markDirty();
    }
  });

  el('groups-list').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.classList.contains('chip-input')) {
      addChipFromInput(event.target);
    }
  });

  el('groups-list').addEventListener('input', markDirty);

  el('schedule-editor').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.action === 'add-range') {
      const ranges = button.parentElement;
      ranges.insertAdjacentHTML('afterbegin', scheduleRangeHtml('09:00', '17:00'));
      markDirty();
    } else if (button.dataset.action === 'remove-range') {
      button.closest('.schedule-range').remove();
      markDirty();
    }
  });

  el('schedule-editor').addEventListener('input', markDirty);

  el('btn-clear-schedule').addEventListener('click', () => {
    config = { ...config, schedule: { windows: [] } };
    renderSchedule();
    markDirty();
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
      el('save-status').textContent = 'Wallpaper URL must start with http(s)://';
      el('save-status').className = 'save-error';
      return;
    }
    const result = await persistConfig({ ...config, wallpaper: { mode: 'url', value } });
    if (result.ok) {
      renderWallpaper();
      renderStatus();
    } else {
      el('save-status').textContent = result.errors[0];
      el('save-status').className = 'save-error';
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (dirty) event.preventDefault();
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE_KEYS.RUNTIME]) {
      await loadState();
      renderStatus();
    }
  });
}

function addChipFromInput(input) {
  if (!input) return;
  const value = input.value.trim();
  if (!value) return;
  const kind = input.dataset.chipKind;
  const chips = input.parentElement.querySelectorAll(`.chip[data-kind="${kind}"]`);
  for (const chip of chips) {
    if (chip.dataset.value === value) {
      input.value = '';
      return;
    }
  }
  input.insertAdjacentHTML('beforebegin', chipHtml(kind, value));
  input.value = '';
  markDirty();
}

async function init() {
  await loadState();
  renderAll();
  wireEvents();
  setInterval(renderStatus, 1000);
}

init();
