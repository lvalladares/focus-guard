import { normalizeHostname, hostSpecsForGroup, compilePathGlob } from './patterns.js';
import { normalizeWindows } from './schedule.js';
import { WALLPAPERS, DEFAULT_WALLPAPER_ID } from './wallpapers.js';

export const CURRENT_SCHEMA_VERSION = 1;

export function defaultConfig() {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    master: { enabled: false },
    schedule: { windows: [] },
    groups: [],
    wallpaper: { mode: 'builtin', value: DEFAULT_WALLPAPER_ID },
  };
}

export function newGroupId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `g_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  }
  return `g_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
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

function normalizeGroup(raw, index, errors, seenExact, seenWildcard) {
  if (!raw || typeof raw !== 'object') {
    errors.push(`groups[${index}]: Invalid group`);
    return null;
  }
  const domainResult = normalizeHostname(raw.domain);
  if (!domainResult.ok) {
    errors.push(`groups[${index}]: ${raw.domain ? `"${raw.domain}" is not a valid domain` : 'Domain is required'} (${domainResult.error})`);
    return null;
  }
  const domain = domainResult.hostname;

  const subdomains = [];
  for (const sub of Array.isArray(raw.subdomains) ? raw.subdomains : []) {
    const res = normalizeHostname(sub);
    if (!res.ok) {
      errors.push(`groups[${index}]: Subdomain "${sub}" ignored (${res.error})`);
      continue;
    }
    if (res.hostname === domain) continue;
    if (!subdomains.includes(res.hostname)) subdomains.push(res.hostname);
  }

  const whitelist = [];
  for (const glob of Array.isArray(raw.whitelist) ? raw.whitelist : []) {
    const res = compilePathGlob(glob);
    if (!res.ok) {
      errors.push(`groups[${index}]: Whitelist path "${glob}" ignored (${res.error})`);
      continue;
    }
    if (!whitelist.includes(res.normalized)) whitelist.push(res.normalized);
  }

  const level = raw.level === 'total' ? 'total' : 'partial';

  const group = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newGroupId(),
    domain,
    includeBaseHost: Boolean(raw.includeBaseHost),
    includeAllSubdomains: Boolean(raw.includeAllSubdomains),
    subdomains,
    whitelist,
    level,
  };

  if (hostSpecsForGroup(group).length === 0) {
    errors.push(`groups[${index}] (${domain}): Select the bare host, specific subdomains, or all subdomains — group has nothing to block`);
  }

  for (const spec of hostSpecsForGroup(group)) {
    if (spec.kind === 'exact') {
      if (seenExact.has(spec.host)) {
        errors.push(`groups[${index}] (${domain}): Host "${spec.host}" is already blocked by another group`);
      } else {
        seenExact.add(spec.host);
      }
    } else if (seenWildcard.has(spec.base)) {
      errors.push(`groups[${index}] (${domain}): Wildcard "*.${spec.base}" is already used by another group`);
    } else {
      seenWildcard.add(spec.base);
    }
  }

  return group;
}

export function normalizeConfig(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') {
    return { config: defaultConfig(), errors };
  }

  const groups = [];
  const seenExact = new Set();
  const seenWildcard = new Set();
  const rawGroups = Array.isArray(raw.groups) ? raw.groups : [];
  rawGroups.forEach((g, i) => {
    const group = normalizeGroup(g, i, errors, seenExact, seenWildcard);
    if (group) groups.push(group);
  });

  const { windows, errors: scheduleErrors } = normalizeWindows(raw.schedule);
  scheduleErrors.forEach((e) => errors.push(`schedule window ${e.index + 1}: ${e.error}`));

  const wallpaper = normalizeWallpaper(raw.wallpaper, errors);

  const config = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    master: { enabled: Boolean(raw.master && raw.master.enabled) },
    schedule: { windows },
    groups,
    wallpaper,
  };

  return { config, errors };
}
