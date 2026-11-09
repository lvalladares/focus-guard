import { safeParseUrl } from './url.js';

const MAX_LABEL_LENGTH = 63;
const MAX_PATH_GLOB_LENGTH = 128;

export function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// `www.` is treated as decoration: `www.example.com` and `example.com` are the same site,
// so both normalize to and match the bare host.
export function stripWwwPrefix(host) {
  if (typeof host !== 'string') return host;
  const lower = host.toLowerCase();
  if (!lower.startsWith('www.')) return lower;
  const rest = lower.slice('www.'.length);
  return rest.split('.').length >= 2 ? rest : lower;
}

export function normalizeHostname(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'Host must be a string' };
  let s = raw.trim().toLowerCase();
  if (!s) return { ok: false, error: 'Host is empty' };
  // Accept whatever the user pastes: scheme, path, port, `//` — keep only the host.
  if (s.includes('://') || s.includes('/')) {
    const parsed = safeParseUrl(s.includes('://') ? s : `https://${s}`);
    if (!parsed) return { ok: false, error: 'Not a valid URL or host' };
    s = parsed.hostname;
  }
  try {
    s = new URL(`https://${s}`).hostname;
  } catch {
    return { ok: false, error: 'Not a valid host' };
  }
  s = s.replace(/\.+$/, '');
  if (!s || s === '.') return { ok: false, error: 'Not a valid host' };
  const labels = s.split('.');
  for (const label of labels) {
    if (!label) return { ok: false, error: 'Empty label in host' };
    if (label.length > MAX_LABEL_LENGTH) return { ok: false, error: 'Host label too long' };
    if (!/^[a-z0-9-]+$/.test(label)) return { ok: false, error: 'Invalid characters in host' };
    if (label.startsWith('-') || label.endsWith('-')) return { ok: false, error: 'Host label cannot start or end with a hyphen' };
  }
  return { ok: true, hostname: stripWwwPrefix(s) };
}

export function hostSpecsForGroup(group) {
  const specs = [];
  if (!group) return specs;
  if (group.includeBaseHost && group.domain) specs.push({ kind: 'exact', host: group.domain });
  for (const sub of group.subdomains || []) {
    if (sub) specs.push({ kind: 'exact', host: sub });
  }
  if (group.includeAllSubdomains && group.domain) specs.push({ kind: 'wildcard', base: group.domain });
  return specs;
}

export function hostnameMatchesSpec(hostname, spec) {
  if (!hostname || !spec) return false;
  const host = hostname.toLowerCase();
  if (spec.kind === 'exact') return stripWwwPrefix(host) === stripWwwPrefix(spec.host);
  if (spec.kind === 'wildcard') return host.endsWith(`.${stripWwwPrefix(spec.base)}`);
  return false;
}

function specSpecificity(spec) {
  return spec.kind === 'exact' ? 2 : 1;
}

export function matchGroupForUrl(url, config) {
  const parsed = safeParseUrl(url);
  if (!parsed || !parsed.hostname) return null;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const hostname = parsed.hostname;
  let best = null;
  for (const group of (config && config.groups) || []) {
    for (const spec of hostSpecsForGroup(group)) {
      if (!hostnameMatchesSpec(hostname, spec)) continue;
      const specificity = specSpecificity(spec);
      const isBetter = !best
        || specificity > best.specificity
        || (specificity === best.specificity && group.level === 'total' && best.group.level !== 'total');
      if (isBetter) best = { group, spec, specificity };
    }
  }
  return best;
}

// Whitelist chips accept a pasted URL or `site.com/section` — only the path is kept.
function pathFromPastedUrl(raw) {
  const isUrl = raw.includes('://');
  const looksLikeHost = /^[^\s/?#]+\.[^\s/?#]+(?::\d+)?/.test(raw);
  if (!isUrl && !looksLikeHost) return { ok: false, error: 'Path must start with "/"' };
  let parsed;
  try {
    parsed = new URL(isUrl ? raw : `https://${raw}`);
  } catch {
    return { ok: false, error: 'Not a valid URL or host' };
  }
  const path = parsed.pathname || '/';
  if (path === '/') {
    return { ok: false, error: 'Pasted URL has no path — add the section, e.g. site.com/section' };
  }
  return { ok: true, path };
}

export function compilePathGlob(glob) {
  if (typeof glob !== 'string') return { ok: false, error: 'Path must be a string' };
  let s = glob.trim();
  if (!s) return { ok: false, error: 'Path is empty' };
  const qIndex = Math.min(
    ...[s.indexOf('?'), s.indexOf('#')].filter((i) => i >= 0).concat([s.length]),
  );
  s = s.slice(0, qIndex);
  if (!s.startsWith('/')) {
    const coerced = pathFromPastedUrl(s);
    if (!coerced.ok) return { ok: false, error: coerced.error };
    s = coerced.path;
  }
  s = s.replace(/\/+$/, '') || '/';
  if (s.length > MAX_PATH_GLOB_LENGTH) return { ok: false, error: 'Path pattern too long' };
  for (const ch of s) {
    if (ch < ' ' || ch > '~' || ch === '"' || ch === '\\') {
      return { ok: false, error: 'Path contains invalid characters' };
    }
  }
  const hasStar = s.includes('*');
  let source;
  if (s === '/') {
    source = '.*';
  } else if (hasStar) {
    source = s.split('*').map(escapeRegExp).join('.*');
  } else {
    const escaped = escapeRegExp(s);
    source = `${escaped}(?:\\/.*)?`;
  }
  return { ok: true, source, exactPrefix: !hasStar, normalized: s };
}

export function pathMatchesGlob(pathname, glob) {
  if (typeof pathname !== 'string' || !glob) return false;
  const compiled = compilePathGlob(glob);
  if (!compiled.ok) return false;
  const re = new RegExp(`^(?:${compiled.source})$`);
  return re.test(pathname);
}

export function isWhitelistedUrl(parsedUrl, group) {
  if (!parsedUrl || !group || !Array.isArray(group.whitelist) || group.whitelist.length === 0) return false;
  for (const glob of group.whitelist) {
    if (pathMatchesGlob(parsedUrl.pathname, glob)) return true;
  }
  return false;
}

export function exactHostsHostOnly(hosts) {
  const unique = [...new Set(hosts.map((h) => stripWwwPrefix(String(h))))];
  const alts = unique.map(escapeRegExp).join('|');
  return `https?://(?:www\\.)?(?:${alts})`;
}

export function wildcardHostOnly(base) {
  return `https?://(?:[a-z0-9-]+\\.)+${escapeRegExp(stripWwwPrefix(String(base)))}`;
}

export function exactHostsRegexSource(hosts) {
  return `${exactHostsHostOnly(hosts)}(?:[/:].*)?`;
}

export function wildcardHostRegexSource(base) {
  return `${wildcardHostOnly(base)}(?:[/:].*)?`;
}

export function groupMatchPatterns(group) {
  const patterns = [];
  for (const spec of hostSpecsForGroup(group)) {
    if (spec.kind === 'exact') {
      const host = stripWwwPrefix(spec.host);
      patterns.push(`*://${host}/*`, `*://www.${host}/*`);
    } else {
      patterns.push(`*://*.${stripWwwPrefix(spec.base)}/*`);
    }
  }
  return [...new Set(patterns)];
}
