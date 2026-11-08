import { describe, it, expect } from 'vitest';
import { aggregateStats, registrableDomain } from '../src/lib/stats-aggregate.js';

const buckets = {
  '2026-11-09': {
    'old.reddit.com': { s: 300, v: 3 },
    'reddit.com': { s: 120, v: 2 },
    'news.ycombinator.com': { s: 180, v: 1 },
    'localhost': { s: 60, v: 1 },
  },
  '2026-11-08': {
    'old.reddit.com': { s: 100, v: 1 },
    'www.reddit.co.uk': { s: 50, v: 1 },
    'bbc.co.uk': { s: 200, v: 2 },
    'docs.python.org': { s: 90, v: 1 },
  },
};

describe('registrableDomain', () => {
  it('reduces subdomains to the registrable domain', () => {
    expect(registrableDomain('old.reddit.com')).toBe('reddit.com');
    expect(registrableDomain('a.b.example.com')).toBe('example.com');
    expect(registrableDomain('reddit.com')).toBe('reddit.com');
    expect(registrableDomain('localhost')).toBe('localhost');
  });

  it('handles common multi-part suffixes', () => {
    expect(registrableDomain('www.bbc.co.uk')).toBe('bbc.co.uk');
    expect(registrableDomain('mail.google.com.au')).toBe('google.com.au');
    expect(registrableDomain('a.b.c.co.jp')).toBe('c.co.jp');
  });

  it('tolerates garbage', () => {
    expect(registrableDomain('')).toBe('');
    expect(registrableDomain(null)).toBe('');
  });
});

describe('aggregateStats', () => {
  it('sums hosts across days, sorted by time', () => {
    const result = aggregateStats(buckets);
    expect(result.totalSeconds).toBe(300 + 120 + 180 + 60 + 100 + 50 + 200 + 90);
    expect(result.totalVisits).toBe(3 + 2 + 1 + 1 + 1 + 1 + 2 + 1);
    expect(result.siteCount).toBe(7);
    expect(result.hosts[0]).toEqual({ hostname: 'old.reddit.com', seconds: 400, visits: 4 });
    expect(result.hosts.map((h) => h.hostname)).toContain('localhost');
  });

  it('groups hosts into domains with children sorted', () => {
    const result = aggregateStats(buckets);
    const reddit = result.domains.find((d) => d.domain === 'reddit.com');
    expect(reddit.seconds).toBe(520);
    expect(reddit.visits).toBe(6);
    expect(reddit.hosts.map((h) => h.hostname)).toEqual(['old.reddit.com', 'reddit.com']);
    expect(reddit.sharePct).toBe(Math.round((520 / 1100) * 100));

    const uk = result.domains.find((d) => d.domain === 'bbc.co.uk');
    expect(uk.hosts.map((h) => h.hostname)).toEqual(['bbc.co.uk']);

    const redditUk = result.domains.find((d) => d.domain === 'reddit.co.uk');
    expect(redditUk.hosts.map((h) => h.hostname)).toEqual(['www.reddit.co.uk']);
  });

  it('sorts domains by time descending', () => {
    const result = aggregateStats(buckets);
    const seconds = result.domains.map((d) => d.seconds);
    const sorted = [...seconds].sort((a, b) => b - a);
    expect(seconds).toEqual(sorted);
  });

  it('computes bar percentages relative to the top domain', () => {
    const result = aggregateStats(buckets);
    const top = result.domains[0];
    expect(top.barPct).toBe(100);
    for (const d of result.domains) {
      expect(d.barPct).toBeGreaterThanOrEqual(2);
      expect(d.barPct).toBeLessThanOrEqual(100);
    }
  });

  it('filters by search query and recomputes shares', () => {
    const result = aggregateStats(buckets, { query: 'reddit' });
    expect(result.siteCount).toBe(3);
    expect(result.totalSeconds).toBe(300 + 120 + 100 + 50);
    expect(result.domains.map((d) => d.domain)).toEqual(['reddit.com', 'reddit.co.uk']);
    expect(result.domains[0].sharePct).toBe(Math.round((520 / 570) * 100));
  });

  it('handles empty and missing data', () => {
    expect(aggregateStats({})).toEqual({
      totalSeconds: 0,
      totalVisits: 0,
      siteCount: 0,
      hosts: [],
      domains: [],
    });
    expect(aggregateStats(null).domains).toEqual([]);
    expect(aggregateStats({ '2026-11-09': null }).totalSeconds).toBe(0);
  });

  it('ignores malformed entries gracefully', () => {
    const result = aggregateStats({ '2026-11-09': { 'a.com': null, 'b.com': { s: 'x', v: 'y' } } });
    expect(result.siteCount).toBe(2);
    expect(result.totalSeconds).toBe(0);
  });
});
