import { hostSpecsForGroup, exactHostsRegexSource, wildcardHostRegexSource, exactHostsHostOnly, wildcardHostOnly, compilePathGlob } from './patterns.js';
import { deriveGroupRuntime } from './sessions.js';
import { isBlockingActive } from './decision.js';
import { PAGES } from './constants.js';

export const MAX_REGEX_FILTER_LENGTH = 240;

const OFFSET_REDIRECT = 0;
const OFFSET_SESSION_ALLOW = 2;
const OFFSET_WHITELIST_ALLOW = 3;

function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function makeIdAllocator() {
  const used = new Set();
  return (key) => {
    let id = (fnv1a(key) % 999999998) + 1;
    while (used.has(id)) id = (id % 999999998) + 1;
    used.add(id);
    return id;
  };
}

function labelCount(host) {
  return host.split('.').length;
}

function chunkExactHosts(hosts, budget) {
  const chunks = [];
  let current = [];
  let currentLength = 0;
  for (const host of hosts) {
    const addition = (current.length > 0 ? 1 : 0) + host.length;
    if (current.length > 0 && currentLength + addition > budget) {
      chunks.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(host);
    currentLength += addition;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function redirectAction(extensionId, pagePath) {
  return {
    type: 'redirect',
    redirect: { regexSubstitution: `chrome-extension://${extensionId}${pagePath}#\\1` },
  };
}

export function buildRules({ config, runtime, now, extensionId }) {
  if (!isBlockingActive(now, config, runtime)) return [];
  const rules = [];
  const allocId = makeIdAllocator();

  for (const group of (config && config.groups) || []) {
    const specs = hostSpecsForGroup(group);
    if (specs.length === 0) continue;

    const exactHosts = specs.filter((s) => s.kind === 'exact').map((s) => s.host);
    const wildcardBases = specs.filter((s) => s.kind === 'wildcard').map((s) => s.base);

    const rt = deriveGroupRuntime(group.id, runtime, now);
    const kind = rt.state === 'session'
      ? 'session-allow'
      : (group.level === 'total' || rt.state === 'cooldown') ? 'block' : 'gate';

    const targetPath = kind === 'gate' ? PAGES.GATE : PAGES.BLOCKED;

    const classes = [];
    if (exactHosts.length > 0) {
      classes.push({ key: 'exact', tier: 100, budget: MAX_REGEX_FILTER_LENGTH - 40, isExact: true });
    }
    for (const base of wildcardBases) {
      classes.push({ key: `wild:${base}`, tier: 10 + labelCount(base), isExact: false, base });
    }

    for (const cls of classes) {
      const hostChunks = cls.isExact
        ? chunkExactHosts(exactHosts, cls.budget)
        : [null];
      hostChunks.forEach((chunk, chunkIndex) => {
        const regexSource = cls.isExact
          ? exactHostsRegexSource(chunk)
          : wildcardHostRegexSource(cls.base);
        const regexFilter = `^(${regexSource})$`;
        if (regexFilter.length > 256) return;
        const priority = cls.tier * 10 + (kind === 'session-allow' ? OFFSET_SESSION_ALLOW : OFFSET_REDIRECT);
        const id = allocId(`${group.id}|${kind}|${cls.key}|${chunkIndex}`);
        rules.push({
          id,
          priority,
          condition: {
            regexFilter,
            resourceTypes: ['main_frame'],
          },
          action: kind === 'session-allow'
            ? { type: 'allow' }
            : redirectAction(extensionId, targetPath),
        });
      });

      if (kind !== 'session-allow' && Array.isArray(group.whitelist) && group.whitelist.length > 0) {
        const whitelistBudget = MAX_REGEX_FILTER_LENGTH - 160 - (group.whitelist.reduce((max, g) => Math.max(max, String(g).length), 0));
        for (const glob of group.whitelist) {
          const compiled = compilePathGlob(glob);
          if (!compiled.ok) continue;
          const whitelistChunks = cls.isExact
            ? chunkExactHosts(exactHosts, Math.max(40, whitelistBudget))
            : [null];
          whitelistChunks.forEach((chunk) => {
            const hostOnly = cls.isExact
              ? exactHostsHostOnly(chunk)
              : wildcardHostOnly(cls.base);
            const regexFilter = `^${hostOnly}(?::\\d+)?(?:${compiled.source})(?:\\?.*)?$`;
            if (regexFilter.length > 256) return;
            const id = allocId(`${group.id}|whitelist|${cls.key}|${glob}`);
            const priority = cls.tier * 10 + OFFSET_WHITELIST_ALLOW;
            rules.push({
              id,
              priority,
              condition: {
                regexFilter,
                resourceTypes: ['main_frame'],
              },
              action: { type: 'allow' },
            });
          });
        }
      }
    }
  }

  return rules;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function diffRules(currentRules, desiredRules) {
  const currentById = new Map();
  for (const rule of currentRules || []) currentById.set(rule.id, rule);
  const desiredById = new Map();
  for (const rule of desiredRules || []) desiredById.set(rule.id, rule);

  const removeRuleIds = [];
  for (const [id, rule] of currentById) {
    const desired = desiredById.get(id);
    if (!desired || stableStringify(rule) !== stableStringify(desired)) removeRuleIds.push(id);
  }
  const addRules = [];
  for (const [id, rule] of desiredById) {
    const current = currentById.get(id);
    if (!current || stableStringify(rule) !== stableStringify(current)) addRules.push(rule);
  }
  return { removeRuleIds, addRules };
}
