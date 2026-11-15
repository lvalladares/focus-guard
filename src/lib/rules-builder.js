import {
  hostSpecsForGroup,
  hostnameMatchesSpec,
  exactHostsRegexSource,
  wildcardHostRegexSource,
  exactHostsHostOnly,
  wildcardHostOnly,
  compilePathGlob,
  pathMatchesGlob,
} from './patterns.js';
import { deriveBlockRuntime } from './sessions.js';
import { isBlockActive } from './decision.js';
import { PAGES } from './constants.js';

export const MAX_REGEX_FILTER_LENGTH = 240;

const OFFSET_REDIRECT = 1;
const OFFSET_WHITELIST_ALLOW = 2;

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

function siteCoversGlob(site, glob) {
  if (!Array.isArray(site.whitelist) || site.whitelist.length === 0) return false;
  if (site.whitelist.includes(glob)) return true;
  // Exact prefix glob is covered if another site has '/' or an identical/broader glob.
  return site.whitelist.some((other) => other === '/' || (glob.startsWith('/') && pathMatchesGlob(glob, other)));
}

function otherBlockBlocksTarget(otherBlocks, currentBlockId, spec, glob) {
  for (const other of otherBlocks) {
    if (other.id === currentBlockId) continue;
    // Find best matching site in other block for this host/base
    const probeHost = spec.kind === 'exact' ? spec.host : `sub.${spec.base}`;
    let best = null;
    for (const site of other.sites || []) {
      for (const otherSpec of hostSpecsForGroup(site)) {
        if (!hostnameMatchesSpec(probeHost, otherSpec)) continue;
        const specificity = (otherSpec.kind === 'exact' ? 2 : 1)
          + (otherSpec.kind === 'wildcard' ? otherSpec.base.split('.').length * 0.01 : 0);
        if (!best || specificity > best.specificity) {
          best = { site, specificity };
        }
      }
    }
    if (best && !siteCoversGlob(best.site, glob)) {
      return true;
    }
  }
  return false;
}

export function buildRules({ config, runtime, blockStates = {}, now, extensionId }) {
  const blocks = (config && Array.isArray(config.blocks)) ? config.blocks : [];
  const activeBlockingBlocks = [];

  for (const block of blocks) {
    if (!isBlockActive(block, now, config, runtime)) continue;
    const rt = deriveBlockRuntime(block, blockStates ? blockStates[block.id] : null, now);
    const isBlocking = rt.state === 'blocked' || rt.state === 'snoozable' || rt.state === 'snoozes-exhausted';
    if (isBlocking) {
      activeBlockingBlocks.push(block);
    }
  }

  if (activeBlockingBlocks.length === 0) return [];

  const rules = [];
  const allocId = makeIdAllocator();

  for (const block of activeBlockingBlocks) {
    for (const site of block.sites || []) {
      const specs = hostSpecsForGroup(site);
      if (specs.length === 0) continue;

      const exactHosts = specs.filter((s) => s.kind === 'exact').map((s) => s.host);
      const wildcardBases = specs.filter((s) => s.kind === 'wildcard').map((s) => s.base);

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
          const priority = cls.tier * 10 + OFFSET_REDIRECT;
          const id = allocId(`${block.id}|${site.id || site.domain}|block|${cls.key}|${chunkIndex}`);
          rules.push({
            id,
            priority,
            condition: {
              regexFilter,
              resourceTypes: ['main_frame'],
            },
            action: redirectAction(extensionId, PAGES.BLOCKED),
          });
        });

        if (Array.isArray(site.whitelist) && site.whitelist.length > 0) {
          const whitelistBudget = MAX_REGEX_FILTER_LENGTH - 160 - site.whitelist.reduce((max, g) => Math.max(max, String(g).length), 0);
          for (const glob of site.whitelist) {
            const compiled = compilePathGlob(glob);
            if (!compiled.ok) continue;

            if (cls.isExact) {
              const allowedExactHosts = exactHosts.filter(
                (host) => !otherBlockBlocksTarget(activeBlockingBlocks, block.id, { kind: 'exact', host }, glob),
              );
              if (allowedExactHosts.length === 0) continue;
              const whitelistChunks = chunkExactHosts(allowedExactHosts, Math.max(40, whitelistBudget));
              whitelistChunks.forEach((chunk, chunkIndex) => {
                const hostOnly = exactHostsHostOnly(chunk);
                const regexFilter = `^${hostOnly}(?::\\d+)?(?:${compiled.source})(?:\\?.*)?$`;
                if (regexFilter.length > 256) return;
                const id = allocId(`${block.id}|${site.id || site.domain}|whitelist|${cls.key}|${glob}|${chunkIndex}`);
                rules.push({
                  id,
                  priority: cls.tier * 10 + OFFSET_WHITELIST_ALLOW,
                  condition: {
                    regexFilter,
                    resourceTypes: ['main_frame'],
                  },
                  action: { type: 'allow' },
                });
              });
            } else {
              if (otherBlockBlocksTarget(activeBlockingBlocks, block.id, { kind: 'wildcard', base: cls.base }, glob)) {
                continue;
              }
              const hostOnly = wildcardHostOnly(cls.base);
              const regexFilter = `^${hostOnly}(?::\\d+)?(?:${compiled.source})(?:\\?.*)?$`;
              if (regexFilter.length > 256) continue;
              const id = allocId(`${block.id}|${site.id || site.domain}|whitelist|${cls.key}|${glob}`);
              rules.push({
                id,
                priority: cls.tier * 10 + OFFSET_WHITELIST_ALLOW,
                condition: {
                  regexFilter,
                  resourceTypes: ['main_frame'],
                },
                action: { type: 'allow' },
              });
            }
          }
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
