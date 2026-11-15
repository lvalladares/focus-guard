import { normalizeHostname, hostSpecsForGroup, compilePathGlob } from './patterns.js';
import { normalizeWindows, isScheduleActive } from './schedule.js';
import { WALLPAPERS, DEFAULT_WALLPAPER_ID } from './wallpapers.js';
import { STATS, DEFAULT_BLOCK_COUNT } from './constants.js';

export const CURRENT_SCHEMA_VERSION = 3;

function makeId(prefix) {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  }
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export function newGroupId() {
  return makeId('g');
}

export function newBlockId() {
  return makeId('b');
}

export function newSiteId() {
  return makeId('s');
}

export function defaultTimeLimit() {
  return { enabled: false, minutes: 20, periodHours: 8 };
}

export function defaultSnooze() {
  return { enabled: false, durationMinutes: 5, maxCount: 1, periodHours: 4 };
}

export function defaultBlock(index = 0, overrides = {}) {
  return {
    id: newBlockId(),
    name: `Block ${index + 1}`,
    enabled: true,
    persistent: false,
    sites: [],
    schedule: { alwaysActive: false, windows: [] },
    timeLimit: defaultTimeLimit(),
    snooze: defaultSnooze(),
    ...overrides,
  };
}

export function defaultConfig() {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    master: { enabled: false },
    antiUninstall: { enabled: false },
    blocks: Array.from({ length: DEFAULT_BLOCK_COUNT }, (_, i) => defaultBlock(i)),
    wallpaper: { mode: 'builtin', value: DEFAULT_WALLPAPER_ID },
    stats: { enabled: true, retentionMonths: STATS.DEFAULT_RETENTION_MONTHS },
  };
}

function normalizeWallpaper(raw, errors) {
  const mode = raw && raw.mode === 'url' ? 'url' : 'builtin';
  const value = raw && typeof raw.value === 'string' ? raw.value.trim() : '';
  if (mode === 'builtin') {
    const found = WALLPAPERS.find((w) => w.id === value);
    if (found) return { mode: 'builtin', value: found.id };
    if (value) errors.push('wallpaper: Unknown built-in wallpaper, using default');
    return { mode: 'builtin', value: DEFAULT_WALLPAPER_ID };
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('bad protocol');
    return { mode: 'url', value };
  } catch {
    errors.push('wallpaper: Custom wallpaper URL must be a valid http(s) URL, using default');
    return { mode: 'builtin', value: DEFAULT_WALLPAPER_ID };
  }
}

function normalizeSite(raw, blockLabel, index, errors, seenExact, seenWildcard) {
  if (!raw || typeof raw !== 'object') {
    errors.push(`${blockLabel} site[${index}]: Invalid site`);
    return null;
  }
  const domainResult = normalizeHostname(raw.domain);
  if (!domainResult.ok) {
    errors.push(`${blockLabel} site[${index}]: ${raw.domain ? `"${raw.domain}" is not a valid domain` : 'Domain is required'} (${domainResult.error})`);
    return null;
  }
  const domain = domainResult.hostname;

  const subdomains = [];
  for (const sub of Array.isArray(raw.subdomains) ? raw.subdomains : []) {
    const res = normalizeHostname(sub);
    if (!res.ok) {
      errors.push(`${blockLabel} site[${index}]: Subdomain "${sub}" ignored (${res.error})`);
      continue;
    }
    if (res.hostname === domain) continue;
    if (!subdomains.includes(res.hostname)) subdomains.push(res.hostname);
  }

  const whitelist = [];
  for (const glob of Array.isArray(raw.whitelist) ? raw.whitelist : []) {
    const res = compilePathGlob(glob);
    if (!res.ok) {
      errors.push(`${blockLabel} site[${index}]: Whitelist path "${glob}" ignored (${res.error})`);
      continue;
    }
    if (!whitelist.includes(res.normalized)) whitelist.push(res.normalized);
  }

  const site = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newSiteId(),
    domain,
    includeBaseHost: Boolean(raw.includeBaseHost),
    includeAllSubdomains: Boolean(raw.includeAllSubdomains),
    subdomains,
    whitelist,
  };

  if (hostSpecsForGroup(site).length === 0) {
    errors.push(`${blockLabel} (${domain}): Select the bare host, specific subdomains, or all subdomains — site has nothing to block`);
  }

  for (const spec of hostSpecsForGroup(site)) {
    if (spec.kind === 'exact') {
      if (seenExact.has(spec.host)) {
        errors.push(`${blockLabel} (${domain}): Host "${spec.host}" is already listed in this block`);
      } else {
        seenExact.add(spec.host);
      }
    } else if (seenWildcard.has(spec.base)) {
      errors.push(`${blockLabel} (${domain}): Wildcard "*.${spec.base}" is already listed in this block`);
    } else {
      seenWildcard.add(spec.base);
    }
  }

  return site;
}

function clampNumber(val, fallback, min, max, round = false) {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  const clamped = Math.min(max, Math.max(min, num));
  return round ? Math.round(clamped) : Math.round(clamped * 100) / 100;
}

function normalizeTimeLimit(raw, blockLabel, errors) {
  const enabled = Boolean(raw && raw.enabled);
  const rawMinutes = raw && raw.minutes !== undefined ? raw.minutes : 20;
  const rawPeriod = raw && raw.periodHours !== undefined ? raw.periodHours : 8;
  const numMinutes = Number(rawMinutes);
  const numPeriod = Number(rawPeriod);
  if (enabled && (!Number.isFinite(numMinutes) || numMinutes < 1 || numMinutes > 1440)) {
    errors.push(`${blockLabel}: Time limit minutes must be between 1 and 1440`);
  }
  if (enabled && (!Number.isFinite(numPeriod) || numPeriod <= 0 || numPeriod > 168)) {
    errors.push(`${blockLabel}: Time limit period must be between 0.1 and 168 hours`);
  }
  return {
    enabled,
    minutes: clampNumber(rawMinutes, 20, 1, 1440, true),
    periodHours: clampNumber(rawPeriod, 8, 0.1, 168, false),
  };
}

function normalizeSnooze(raw, blockLabel, errors) {
  const enabled = Boolean(raw && raw.enabled);
  const rawDuration = raw && raw.durationMinutes !== undefined ? raw.durationMinutes : 5;
  const rawMax = raw && raw.maxCount !== undefined ? raw.maxCount : 1;
  const rawPeriod = raw && raw.periodHours !== undefined ? raw.periodHours : 4;
  if (enabled && (!Number.isFinite(Number(rawDuration)) || Number(rawDuration) < 1 || Number(rawDuration) > 180)) {
    errors.push(`${blockLabel}: Snooze duration must be between 1 and 180 minutes`);
  }
  if (enabled && (!Number.isFinite(Number(rawMax)) || Number(rawMax) < 1 || Number(rawMax) > 100)) {
    errors.push(`${blockLabel}: Snooze count must be between 1 and 100`);
  }
  if (enabled && (!Number.isFinite(Number(rawPeriod)) || Number(rawPeriod) <= 0 || Number(rawPeriod) > 168)) {
    errors.push(`${blockLabel}: Snooze period must be between 0.1 and 168 hours`);
  }
  return {
    enabled,
    durationMinutes: clampNumber(rawDuration, 5, 1, 180, true),
    maxCount: clampNumber(rawMax, 1, 1, 100, true),
    periodHours: clampNumber(rawPeriod, 4, 0.1, 168, false),
  };
}

function normalizeBlock(raw, index, errors) {
  if (!raw || typeof raw !== 'object') {
    errors.push(`blocks[${index}]: Invalid block`);
    return null;
  }
  const rawName = typeof raw.name === 'string' ? raw.name.trim() : '';
  const name = rawName ? rawName.slice(0, 60) : `Block ${index + 1}`;
  const blockLabel = `Block "${name}"`;

  const sites = [];
  const seenExact = new Set();
  const seenWildcard = new Set();
  for (const [si, s] of (Array.isArray(raw.sites) ? raw.sites : []).entries()) {
    const site = normalizeSite(s, blockLabel, si, errors, seenExact, seenWildcard);
    if (site) sites.push(site);
  }

  const { windows, errors: scheduleErrors } = normalizeWindows(raw.schedule);
  scheduleErrors.forEach((e) => errors.push(`${blockLabel} schedule window ${e.index + 1}: ${e.error}`));

  const alwaysActive = Boolean(raw.schedule && raw.schedule.alwaysActive);

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newBlockId(),
    name,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    persistent: Boolean(raw.persistent),
    sites,
    schedule: { alwaysActive, windows },
    timeLimit: normalizeTimeLimit(raw.timeLimit, blockLabel, errors),
    snooze: normalizeSnooze(raw.snooze, blockLabel, errors),
  };
}

function normalizeStats(raw, errors) {
  const enabled = raw && typeof raw.enabled === 'boolean' ? raw.enabled : true;
  let retentionMonths = Number(raw && raw.retentionMonths);
  if (!Number.isFinite(retentionMonths) || retentionMonths < 1) {
    if (raw && raw.retentionMonths != null) errors.push('stats: Retention must be at least 1 month, using default');
    retentionMonths = STATS.DEFAULT_RETENTION_MONTHS;
  }
  retentionMonths = Math.min(120, Math.round(retentionMonths));
  return { enabled, retentionMonths };
}

function migrateLegacyToBlocks(raw) {
  const groups = Array.isArray(raw.groups) ? raw.groups : [];
  const schedule = raw.schedule || { windows: [] };
  if (groups.length === 0) {
    return Array.from({ length: DEFAULT_BLOCK_COUNT }, (_, i) => defaultBlock(i, i === 0 ? { schedule } : {}));
  }
  const totalGroups = groups.filter((g) => g && g.level === 'total');
  const partialGroups = groups.filter((g) => g && g.level !== 'total');
  const blocks = [];
  if (totalGroups.length > 0) {
    blocks.push(defaultBlock(blocks.length, {
      name: 'Strict Block',
      sites: totalGroups.map(({ level: _level, ...rest }) => rest),
      schedule,
    }));
  }
  if (partialGroups.length > 0) {
    blocks.push(defaultBlock(blocks.length, {
      name: 'Timed Block',
      sites: partialGroups.map(({ level: _level, ...rest }) => rest),
      schedule,
      snooze: { enabled: true, durationMinutes: 10, maxCount: 3, periodHours: 8 },
    }));
  }
  while (blocks.length < DEFAULT_BLOCK_COUNT) {
    blocks.push(defaultBlock(blocks.length));
  }
  return blocks;
}

export function normalizeConfig(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') {
    return { config: defaultConfig(), errors };
  }

  let rawBlocks;
  if (Array.isArray(raw.blocks)) {
    rawBlocks = raw.blocks;
  } else if (Array.isArray(raw.groups) || raw.schedule) {
    rawBlocks = migrateLegacyToBlocks(raw);
  } else {
    rawBlocks = Array.from({ length: DEFAULT_BLOCK_COUNT }, (_, i) => defaultBlock(i));
  }

  const blocks = [];
  const seenBlockIds = new Set();
  rawBlocks.forEach((b, i) => {
    const block = normalizeBlock(b, i, errors);
    if (!block) return;
    if (seenBlockIds.has(block.id)) block.id = newBlockId();
    seenBlockIds.add(block.id);
    blocks.push(block);
  });

  const wallpaper = normalizeWallpaper(raw.wallpaper, errors);
  const stats = normalizeStats(raw.stats, errors);

  const config = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    master: { enabled: Boolean(raw.master && raw.master.enabled) },
    antiUninstall: { enabled: Boolean(raw.antiUninstall && raw.antiUninstall.enabled) },
    blocks,
    wallpaper,
    stats,
  };

  return { config, errors };
}

export function isBlockLocked(block, now) {
  if (!block || !block.enabled || !block.persistent) return false;
  return isScheduleActive(new Date(now), block.schedule);
}

export function hasActivePersistentBlock(config, now) {
  return Boolean(config && Array.isArray(config.blocks) && config.blocks.some((b) => isBlockLocked(b, now)));
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function validateLockedBlockChanges(prevConfig, nextConfig, now) {
  const errors = [];
  if (!prevConfig || !Array.isArray(prevConfig.blocks)) return { ok: true, errors };

  const nextById = new Map(((nextConfig && nextConfig.blocks) || []).map((b) => [b.id, b]));
  let anyLocked = false;

  for (const prevBlock of prevConfig.blocks) {
    if (!isBlockLocked(prevBlock, now)) continue;
    anyLocked = true;
    const nextBlock = nextById.get(prevBlock.id);
    if (!nextBlock) {
      errors.push(`Block "${prevBlock.name}" is in persistent mode during active hours and cannot be deleted`);
      continue;
    }
    if (stableStringify(prevBlock) !== stableStringify(nextBlock)) {
      errors.push(`Block "${prevBlock.name}" is in persistent mode during active hours and cannot be modified or disabled`);
    }
  }

  if (
    anyLocked
    && prevConfig.antiUninstall && prevConfig.antiUninstall.enabled
    && !(nextConfig && nextConfig.antiUninstall && nextConfig.antiUninstall.enabled)
  ) {
    errors.push('Anti-uninstall protection cannot be disabled while a persistent block is active');
  }

  return { ok: errors.length === 0, errors };
}
