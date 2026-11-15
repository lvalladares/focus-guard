import { describe, it, expect } from 'vitest';
import { buildRules, diffRules } from '../src/lib/rules-builder.js';
import { evaluate } from '../src/lib/decision.js';
import { activateBlockSnooze, addBlockUsage, emptyBlockState } from '../src/lib/sessions.js';

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const NOW = new Date('2026-11-09T10:00:00').getTime();
const MIN = 60 * 1000;

function makeSite(overrides = {}) {
  return {
    id: 's1',
    domain: 'reddit.com',
    includeBaseHost: true,
    includeAllSubdomains: false,
    subdomains: [],
    whitelist: [],
    ...overrides,
  };
}

function makeBlock(overrides = {}) {
  return {
    id: 'b1',
    name: 'Block 1',
    enabled: true,
    persistent: false,
    sites: [makeSite()],
    schedule: { alwaysActive: false, windows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }] },
    timeLimit: { enabled: false, minutes: 20, periodHours: 8 },
    snooze: { enabled: false, durationMinutes: 5, maxCount: 1, periodHours: 4 },
    ...overrides,
  };
}

function makeConfig(blocks, extra = {}) {
  return {
    schemaVersion: 3,
    master: { enabled: false },
    antiUninstall: { enabled: false },
    blocks,
    wallpaper: { mode: 'builtin', value: 'aurora' },
    ...extra,
  };
}

const runtime = (overrides = {}) => ({ override: null, ...overrides });

describe('buildRules', () => {
  it('returns no rules when no block is active', () => {
    const cfg = makeConfig([makeBlock()]);
    expect(buildRules({ config: cfg, runtime: runtime(), now: new Date('2026-11-09T20:00:00').getTime(), extensionId: EXT_ID })).toEqual([]);
    const emptySchedule = makeConfig([makeBlock({ schedule: { alwaysActive: false, windows: [] } })]);
    expect(buildRules({ config: emptySchedule, runtime: runtime(), now: NOW, extensionId: EXT_ID })).toEqual([]);
  });

  it('builds a redirect rule to blocked.html for active blocking blocks', () => {
    const rules = buildRules({ config: makeConfig([makeBlock()]), runtime: runtime(), now: NOW, extensionId: EXT_ID });
    expect(rules).toHaveLength(1);
    expect(rules[0].priority).toBe(1001);
    expect(rules[0].action.type).toBe('redirect');
    expect(rules[0].action.redirect.regexSubstitution).toBe(`chrome-extension://${EXT_ID}/src/pages/blocked/blocked.html#\\1`);
  });

  it('emits no redirect rules while a block is in an active snooze or has remaining budget', () => {
    const snoozeBlock = makeBlock({ snooze: { enabled: true, durationMinutes: 5, maxCount: 1, periodHours: 4 } });
    const { state } = activateBlockSnooze(snoozeBlock, emptyBlockState(), NOW);
    expect(buildRules({ config: makeConfig([snoozeBlock]), runtime: runtime(), blockStates: { b1: state }, now: NOW + MIN, extensionId: EXT_ID })).toEqual([]);

    const budgetBlock = makeBlock({ timeLimit: { enabled: true, minutes: 20, periodHours: 8 } });
    expect(buildRules({ config: makeConfig([budgetBlock]), runtime: runtime(), blockStates: {}, now: NOW, extensionId: EXT_ID })).toEqual([]);
  });

  it('adds whitelist allow rules above redirects', () => {
    const cfg = makeConfig([makeBlock({ sites: [makeSite({ whitelist: ['/docs'] })] })]);
    const rules = buildRules({ config: cfg, runtime: runtime(), now: NOW, extensionId: EXT_ID });
    expect(rules).toHaveLength(2);
    const [allow, redirect] = [...rules].sort((a, b) => b.priority - a.priority);
    expect(allow.action).toEqual({ type: 'allow' });
    expect(allow.priority).toBe(1002);
    expect(redirect.priority).toBe(1001);
  });

  it('chunks many hosts while keeping regexFilters within DNR limits', () => {
    const subdomains = Array.from({ length: 40 }, (_, i) => `sub${String(i).padStart(3, '0')}.verylongdomainname.example.com`);
    const rules = buildRules({
      config: makeConfig([makeBlock({ sites: [makeSite({ subdomains })] })]),
      runtime: runtime(),
      now: NOW,
      extensionId: EXT_ID,
    });
    expect(rules.length).toBeGreaterThan(1);
    for (const rule of rules) {
      expect(rule.condition.regexFilter.length).toBeLessThanOrEqual(256);
    }
  });
});

describe('diffRules', () => {
  const ruleA = { id: 1, priority: 1000, condition: { regexFilter: '^(x)$', resourceTypes: ['main_frame'] }, action: { type: 'allow' } };
  const ruleA2 = { id: 1, priority: 1001, condition: { regexFilter: '^(x)$', resourceTypes: ['main_frame'] }, action: { type: 'allow' } };
  const ruleB = { id: 2, priority: 120, condition: { regexFilter: '^(y)$', resourceTypes: ['main_frame'] }, action: { type: 'allow' } };

  it('detects identical, updated, added, and removed rules', () => {
    expect(diffRules([ruleA], [ruleA])).toEqual({ removeRuleIds: [], addRules: [] });
    expect(diffRules([ruleA], [ruleA2])).toEqual({ removeRuleIds: [1], addRules: [ruleA2] });
    expect(diffRules([ruleA], [ruleA, ruleB])).toEqual({ removeRuleIds: [], addRules: [ruleB] });
    expect(diffRules([ruleA, ruleB], [ruleA])).toEqual({ removeRuleIds: [2], addRules: [] });
  });
});

describe('rules-builder matches evaluate (consistency)', () => {
  const snoozeBlock = makeBlock({ id: 'b_sn', snooze: { enabled: true, durationMinutes: 5, maxCount: 1, periodHours: 4 } });
  const budgetBlock = makeBlock({ id: 'b_bg', timeLimit: { enabled: true, minutes: 20, periodHours: 8 } });
  const snoozeActive = activateBlockSnooze(snoozeBlock, emptyBlockState(), NOW - MIN).state;
  const budgetSpent = addBlockUsage(budgetBlock, emptyBlockState(), 20 * MIN, NOW);

  const scenarios = [
    { name: 'hard block', blocks: [makeBlock()], blockStates: {} },
    { name: 'snoozable block', blocks: [snoozeBlock], blockStates: {} },
    { name: 'active snooze', blocks: [snoozeBlock], blockStates: { b_sn: snoozeActive } },
    { name: 'active budget', blocks: [budgetBlock], blockStates: {} },
    { name: 'exhausted budget', blocks: [budgetBlock], blockStates: { b_bg: budgetSpent } },
    {
      name: 'wildcard with whitelist',
      blocks: [makeBlock({ sites: [makeSite({ includeBaseHost: false, includeAllSubdomains: true, whitelist: ['/docs', '/help*'] })] })],
      blockStates: {},
    },
    {
      name: 'overlapping blocks: broad snoozed + narrow blocked',
      blocks: [
        makeBlock({ id: 'broad', sites: [makeSite({ includeBaseHost: false, includeAllSubdomains: true })], snooze: { enabled: true, durationMinutes: 5, maxCount: 1, periodHours: 4 } }),
        makeBlock({ id: 'narrow', sites: [makeSite({ domain: 'old.reddit.com', includeBaseHost: true })] }),
      ],
      blockStates: { broad: activateBlockSnooze(makeBlock({ id: 'broad', snooze: { enabled: true, durationMinutes: 5, maxCount: 1, periodHours: 4 } }), emptyBlockState(), NOW).state },
    },
    {
      name: 'overlapping blocks: exact budget + broad hard block (most restrictive wins)',
      blocks: [
        makeBlock({ id: 'broad_hard', sites: [makeSite({ includeBaseHost: false, includeAllSubdomains: true })] }),
        makeBlock({ id: 'exact_budget', sites: [makeSite({ domain: 'old.reddit.com', includeBaseHost: true })], timeLimit: { enabled: true, minutes: 20, periodHours: 8 } }),
      ],
      blockStates: {},
    },
    {
      name: 'overlapping blocks: block1 hard without whitelist vs block2 with whitelist (most restrictive wins)',
      blocks: [
        makeBlock({ id: 'b_hard', sites: [makeSite({ whitelist: [] })] }),
        makeBlock({ id: 'b_wl', sites: [makeSite({ whitelist: ['/docs'] })] }),
      ],
      blockStates: {},
    },
  ];

  const urls = [
    'https://reddit.com/',
    'https://reddit.com/r/productivity',
    'https://reddit.com:8080/r/x?query=1',
    'https://old.reddit.com/r/nostalgia',
    'https://old.reddit.com/docs',
    'https://docs.reddit.com/',
    'https://reddit.com/docs/api',
    'https://reddit.com/help/me',
    'https://reddit.com.evil.io/',
    'http://reddit.com/',
    'https://www.reddit.com/',
    'https://www.old.reddit.com/r/nostalgia',
    'https://www.reddit.com/docs/api',
  ];

  for (const scenario of scenarios) {
    it(`simulates DNR identically to evaluate: ${scenario.name}`, () => {
      const cfg = makeConfig(scenario.blocks);
      const rules = buildRules({ config: cfg, runtime: runtime(), blockStates: scenario.blockStates, now: NOW, extensionId: EXT_ID });
      for (const url of urls) {
        const expected = evaluate({ url, now: NOW, config: cfg, runtime: runtime(), blockStates: scenario.blockStates });
        const matched = rules
          .filter((r) => new RegExp(r.condition.regexFilter, 'i').test(url))
          .sort((a, b) => b.priority - a.priority)[0];
        if (!matched || matched.action.type === 'allow') {
          expect(expected.verdict).toBe('allow');
        } else {
          expect(expected.verdict === 'block' || expected.verdict === 'block-snoozable').toBe(true);
        }
      }
    });
  }
});
