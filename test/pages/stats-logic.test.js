import { describe, it, expect } from 'vitest';
import { formatHours, isHostBlocked, buildStatsModel, statsTableHtml } from '../../src/pages/settings/stats-logic.js';

const config = {
  groups: [
    { id: 'g1', domain: 'reddit.com', includeBaseHost: true, includeAllSubdomains: false, subdomains: ['old.reddit.com'], whitelist: [], level: 'total' },
    { id: 'g2', domain: 'news.com', includeBaseHost: false, includeAllSubdomains: true, subdomains: [], whitelist: [], level: 'partial' },
  ],
};

const buckets = {
  '2026-11-09': {
    'old.reddit.com': { s: 3725, v: 3 },
    'reddit.com': { s: 120, v: 2 },
    'news.ycombinator.com': { s: 180, v: 1 },
  },
};

describe('formatHours', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatHours(45)).toBe('45s');
    expect(formatHours(60)).toBe('1m');
    expect(formatHours(125)).toBe('2m 5s');
    expect(formatHours(3600)).toBe('1h');
    expect(formatHours(6300)).toBe('1h 45m');
    expect(formatHours(0)).toBe('0s');
    expect(formatHours(null)).toBe('0s');
  });
});

describe('isHostBlocked', () => {
  it('matches base hosts, explicit subdomains and wildcards', () => {
    expect(isHostBlocked('reddit.com', config)).toBe(true);
    expect(isHostBlocked('old.reddit.com', config)).toBe(true);
    expect(isHostBlocked('new.reddit.com', config)).toBe(false);
    expect(isHostBlocked('world.news.com', config)).toBe(true);
    expect(isHostBlocked('news.com', config)).toBe(false);
    expect(isHostBlocked('unrelated.com', config)).toBe(false);
    expect(isHostBlocked('anything.com', { groups: [] })).toBe(false);
  });
});

describe('buildStatsModel', () => {
  it('marks blocked domains and hosts with sub-bar percentages', () => {
    const model = buildStatsModel(buckets, { config });
    const reddit = model.domains.find((d) => d.domain === 'reddit.com');
    expect(reddit.blocked).toBe(true);
    expect(reddit.hosts.find((h) => h.hostname === 'old.reddit.com').blocked).toBe(true);
    expect(reddit.hosts.find((h) => h.hostname === 'old.reddit.com').barPct).toBe(100);
    expect(reddit.hosts.find((h) => h.hostname === 'reddit.com').barPct).toBe(Math.max(2, Math.round((120 / 3725) * 100)));

    const hn = model.domains.find((d) => d.domain === 'ycombinator.com');
    expect(hn.blocked).toBe(false);
    expect(hn.hosts[0].blocked).toBe(false);
  });

  it('passes through aggregates', () => {
    const model = buildStatsModel(buckets, { config });
    expect(model.totalSeconds).toBe(3725 + 120 + 180);
    expect(model.siteCount).toBe(3);
  });
});

describe('statsTableHtml', () => {
  it('renders rows with expanders only for multi-host domains', () => {
    const model = buildStatsModel(buckets, { config });
    const html = statsTableHtml(model);
    expect(html).toContain('data-domain-block="reddit.com"');
    expect(html).toContain('data-block-domain="reddit.com"');
    expect(html).toContain('1h 2m');
    expect(html).toContain('data-children-of="reddit.com"');
    expect(html).toContain('class="stats-children hidden"');
    expect(html).not.toContain('data-expand="news.ycombinator.com"');
    expect(html).toContain('<span class="badge">blocked</span>');
    expect(html).toContain('expander-spacer');
  });

  it('renders expanded state when set', () => {
    const model = buildStatsModel(buckets, { config });
    model.domains = model.domains.map((d) => ({ ...d, expanded: d.domain === 'reddit.com' }));
    const html = statsTableHtml(model);
    expect(html).toContain('class="stats-children"');
    expect(html).toContain('expander open');
  });

  it('shows a friendly empty state', () => {
    expect(statsTableHtml({ domains: [] })).toContain('No tracked time');
    expect(statsTableHtml(null)).toContain('No tracked time');
  });

  it('escapes hostile hostnames', () => {
    const model = buildStatsModel({ '2026-11-09': { '<script>x</script>': { s: 10, v: 1 } } }, { config });
    const html = statsTableHtml(model);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
