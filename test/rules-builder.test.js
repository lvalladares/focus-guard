import { describe, it, expect } from 'vitest';
import { buildRules, diffRules } from '../src/lib/rules-builder.js';
import { evaluate } from '../src/lib/decision.js';
import { startSession } from '../src/lib/sessions.js';

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const NOW = new Date('2026-11-09T10:00:00').getTime();
const MIN = 60 * 1000;

function config(groups, extra = {}) {
  return {
    master: { enabled: false },
    schedule: { windows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }] },
    groups,
    wallpaper: { mode: 'builtin', value: 'aurora' },
    ...extra,
  };
}

function group(overrides = {}) {
  return {
    id: 'g1',
    domain: 'reddit.com',
    includeBaseHost: true,
    includeAllSubdomains: false,
    subdomains: [],
    whitelist: [],
    level: 'total',
    ...overrides,
  };
}

const runtime = (overrides = {}) => ({ sessions: {}, cooldowns: {}, override: null, ...overrides });

describe('buildRules', () => {
  it('returns no rules when blocking is off', () => {
    const off = config([group()], { master: { enabled: false } });
    expect(buildRules({ config: off, runtime: runtime(), now: new Date('2026-11-09T20:00:00').getTime(), extensionId: EXT_ID })).toEqual([]);
    const emptySchedule = config([group()], { schedule: { windows: [] } });
    expect(buildRules({ config: emptySchedule, runtime: runtime(), now: NOW, extensionId: EXT_ID })).toEqual([]);
  });

  it('builds a redirect rule for total blocks', () => {
    const rules = buildRules({ config: config([group()]), runtime: runtime(), now: NOW, extensionId: EXT_ID });
    expect(rules).toHaveLength(1);
    const rule = rules[0];
    expect(rule.priority).toBe(1000);
    expect(rule.condition.regexFilter).toBe('^(https?://(?:reddit\\.com)(?:[/:].*)?)$');
    expect(rule.condition.resourceTypes).toEqual(['main_frame']);
    expect(rule.action.type).toBe('redirect');
    expect(rule.action.redirect.regexSubstitution).toBe(`chrome-extension://${EXT_ID}/src/pages/blocked/blocked.html#\\1`);
  });

  it('redirects partial groups to the gate page', () => {
    const rules = buildRules({ config: config([group({ level: 'partial' })]), runtime: runtime(), now: NOW, extensionId: EXT_ID });
    expect(rules[0].action.redirect.regexSubstitution).toContain('/src/pages/gate/gate.html#\\1');
  });

  it('redirects to the blocked page during cooldown instead of the gate', () => {
    const rt = runtime({ cooldowns: { g1: { startedAt: NOW - MIN, until: NOW + 9 * MIN } } });
    const rules = buildRules({ config: config([group({ level: 'partial' })]), runtime: rt, now: NOW, extensionId: EXT_ID });
    expect(rules[0].action.redirect.regexSubstitution).toContain('/src/pages/blocked/blocked.html#\\1');
  });

  it('emits an allow rule while a session is active', () => {
    const rt = runtime({ sessions: { g1: startSession({ groupId: 'g1', minutes: 10, now: NOW - MIN }) } });
    const rules = buildRules({ config: config([group({ level: 'partial' })]), runtime: rt, now: NOW, extensionId: EXT_ID });
    expect(rules).toHaveLength(1);
    expect(rules[0].action).toEqual({ type: 'allow' });
    expect(rules[0].priority).toBe(1002);
  });

  it('builds a subdomain-only regex for wildcard groups with lower priority', () => {
    const rules = buildRules({ config: config([group({ includeBaseHost: false, includeAllSubdomains: true })]), runtime: runtime(), now: NOW, extensionId: EXT_ID });
    expect(rules[0].condition.regexFilter).toBe('^(https?://(?:[a-z0-9-]+\\.)+reddit\\.com(?:[/:].*)?)$');
    expect(rules[0].priority).toBe(120);
  });

  it('gives deeper wildcards higher priority than broad ones', () => {
    const cfg = config([
      group({ id: 'broad', domain: 'reddit.com', includeBaseHost: false, includeAllSubdomains: true }),
      group({ id: 'narrow', domain: 'old.reddit.com', includeBaseHost: false, includeAllSubdomains: true }),
    ]);
    const rt = runtime({ sessions: { broad: startSession({ groupId: 'broad', minutes: 10, now: NOW }) } });
    const rules = buildRules({ config: cfg, runtime: rt, now: NOW, extensionId: EXT_ID });
    const broad = rules.find((r) => r.action.type === 'allow');
    const narrow = rules.find((r) => r.action.type === 'redirect');
    expect(broad.priority).toBe(122);
    expect(narrow.priority).toBe(130);
    expect(narrow.priority).toBeGreaterThan(broad.priority);
  });

  it('adds whitelist allow rules above redirects', () => {
    const cfg = config([group({ whitelist: ['/docs'] })]);
    const rules = buildRules({ config: cfg, runtime: runtime(), now: NOW, extensionId: EXT_ID });
    expect(rules).toHaveLength(2);
    const [allow, redirect] = [...rules].sort((a, b) => b.priority - a.priority);
    expect(allow.action).toEqual({ type: 'allow' });
    expect(allow.priority).toBe(1003);
    expect(allow.condition.regexFilter).toBe('^https?://(?:reddit\\.com)(?::\\d+)?(?:/docs(?:\\/.*)?)(?:\\?.*)?$');
    expect(redirect.priority).toBe(1000);
  });

  it('skips whitelist rules while a session is active', () => {
    const rt = runtime({ sessions: { g1: startSession({ groupId: 'g1', minutes: 10, now: NOW }) } });
    const rules = buildRules({ config: config([group({ whitelist: ['/docs'] })]), runtime: rt, now: NOW, extensionId: EXT_ID });
    expect(rules).toHaveLength(1);
    expect(rules[0].action.type).toEqual({ type: 'allow' }.type);
  });

  it('chunks many hosts while keeping regexFilters within DNR limits', () => {
    const subdomains = Array.from({ length: 40 }, (_, i) => `sub${String(i).padStart(3, '0')}.verylongdomainname.example.com`);
    const rules = buildRules({ config: config([group({ subdomains })]), runtime: runtime(), now: NOW, extensionId: EXT_ID });
    expect(rules.length).toBeGreaterThan(1);
    for (const rule of rules) {
      expect(rule.condition.regexFilter.length).toBeLessThanOrEqual(256);
    }
    const hostsCovered = new Set();
    for (const rule of rules) {
      for (const host of subdomains) {
        const re = new RegExp(rule.condition.regexFilter);
        if (re.test(`https://${host}/x`)) hostsCovered.add(host);
      }
    }
    expect(hostsCovered.size).toBe(subdomains.length);
  });

  it('produces unique ids and is deterministic', () => {
    const cfg = config([group({ whitelist: ['/docs'], includeAllSubdomains: true }), group({ id: 'g2', domain: 'news.com', includeBaseHost: true, level: 'partial' })]);
    const a = buildRules({ config: cfg, runtime: runtime(), now: NOW, extensionId: EXT_ID });
    const b = buildRules({ config: cfg, runtime: runtime(), now: NOW, extensionId: EXT_ID });
    expect(a).toEqual(b);
    expect(new Set(a.map((r) => r.id)).size).toBe(a.length);
    for (const rule of a) {
      expect(rule.condition.regexFilter.length).toBeLessThanOrEqual(256);
    }
  });
});

describe('diffRules', () => {
  const ruleA = { id: 1, priority: 1000, condition: { regexFilter: '^(x)$', resourceTypes: ['main_frame'] }, action: { type: 'allow' } };
  const ruleA2 = { id: 1, priority: 1001, condition: { regexFilter: '^(x)$', resourceTypes: ['main_frame'] }, action: { type: 'allow' } };
  const ruleB = { id: 2, priority: 120, condition: { regexFilter: '^(y)$', resourceTypes: ['main_frame'] }, action: { type: 'allow' } };

  it('reports nothing when identical', () => {
    expect(diffRules([ruleA], [ruleA])).toEqual({ removeRuleIds: [], addRules: [] });
  });

  it('detects updates by content even with the same id', () => {
    const diff = diffRules([ruleA], [ruleA2]);
    expect(diff.removeRuleIds).toEqual([1]);
    expect(diff.addRules).toEqual([ruleA2]);
  });

  it('detects additions and removals', () => {
    expect(diffRules([ruleA], [ruleA, ruleB])).toEqual({ removeRuleIds: [], addRules: [ruleB] });
    expect(diffRules([ruleA, ruleB], [ruleA])).toEqual({ removeRuleIds: [2], addRules: [] });
    expect(diffRules([], [ruleA])).toEqual({ removeRuleIds: [], addRules: [ruleA] });
  });
});

describe('rules-builder matches evaluate (consistency)', () => {
  const scenarios = [
    {
      name: 'total group',
      groups: [group()],
      runtime: runtime(),
    },
    {
      name: 'partial group',
      groups: [group({ level: 'partial' })],
      runtime: runtime(),
    },
    {
      name: 'partial with active session',
      groups: [group({ level: 'partial' })],
      runtime: runtime({ sessions: { g1: startSession({ groupId: 'g1', minutes: 20, now: NOW - 5 * MIN }) } }),
    },
    {
      name: 'partial after session expiry (derived cooldown)',
      groups: [group({ level: 'partial' })],
      runtime: runtime({ sessions: { g1: startSession({ groupId: 'g1', minutes: 10, now: NOW - 15 * MIN }) } }),
    },
    {
      name: 'partial in recorded cooldown',
      groups: [group({ level: 'partial' })],
      runtime: runtime({ cooldowns: { g1: { startedAt: NOW, until: NOW + 5 * MIN } } }),
    },
    {
      name: 'wildcard total group',
      groups: [group({ includeBaseHost: false, includeAllSubdomains: true })],
      runtime: runtime(),
    },
    {
      name: 'whitelisted paths',
      groups: [group({ whitelist: ['/docs', '/help*'] })],
      runtime: runtime(),
    },
    {
      name: 'multiple groups with specificity overlap',
      groups: [
        group({ id: 'broad', includeBaseHost: false, includeAllSubdomains: true, level: 'partial' }),
        group({ id: 'exact', domain: 'old.reddit.com', includeBaseHost: true, level: 'total' }),
      ],
      runtime: runtime({ sessions: { broad: startSession({ groupId: 'broad', minutes: 30, now: NOW }) } }),
    },
  ];

  const urls = [
    'https://reddit.com/',
    'https://reddit.com/r/productivity',
    'https://reddit.com:8080/r/x?query=1',
    'https://old.reddit.com/r/nostalgia',
    'https://docs.reddit.com/',
    'https://reddit.com/docs/api',
    'https://reddit.com/help/me',
    'https://reddit.com.evil.io/',
    'http://reddit.com/',
  ];

  for (const scenario of scenarios) {
    it(`simulates DNR identically to evaluate: ${scenario.name}`, () => {
      const cfg = config(scenario.groups);
      const rules = buildRules({ config: cfg, runtime: scenario.runtime, now: NOW, extensionId: EXT_ID });
      for (const url of urls) {
        const expected = evaluate({ url, now: NOW, config: cfg, runtime: scenario.runtime });
        const matched = rules
          .filter((r) => new RegExp(r.condition.regexFilter, 'i').test(url))
          .sort((a, b) => b.priority - a.priority)[0];
        if (!matched) {
          expect(expected.verdict).toBe('allow');
          continue;
        }
        if (matched.action.type === 'allow') {
          expect(expected.verdict).toBe('allow');
        } else {
          const target = matched.action.redirect.regexSubstitution;
          if (target.includes('/gate.html')) {
            expect(expected.verdict).toBe('gate');
          } else {
            expect(expected.verdict).toBe(scenario.groups.find((g) => g.level === 'total') ? 'block' : 'cooldown');
          }
        }
      }
    });
  }
});
