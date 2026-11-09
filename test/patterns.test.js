import { describe, it, expect } from 'vitest';
import {
  normalizeHostname,
  hostSpecsForGroup,
  hostnameMatchesSpec,
  matchGroupForUrl,
  compilePathGlob,
  pathMatchesGlob,
  isWhitelistedUrl,
  exactHostsRegexSource,
  wildcardHostRegexSource,
  exactHostsHostOnly,
  wildcardHostOnly,
  groupMatchPatterns,
} from '../src/lib/patterns.js';

describe('normalizeHostname', () => {
  it('normalizes case and whitespace', () => {
    expect(normalizeHostname('  Reddit.COM ')).toEqual({ ok: true, hostname: 'reddit.com' });
  });

  it('extracts host from pasted URLs', () => {
    expect(normalizeHostname('https://reddit.com/r/productivity')).toEqual({ ok: true, hostname: 'reddit.com' });
    expect(normalizeHostname('reddit.com/r/productivity')).toEqual({ ok: true, hostname: 'reddit.com' });
    expect(normalizeHostname('http://www.reddit.com/r/productivity?x=1')).toEqual({ ok: true, hostname: 'reddit.com' });
  });

  it('drops the www prefix so both spellings normalize alike', () => {
    expect(normalizeHostname('www.reddit.com')).toEqual({ ok: true, hostname: 'reddit.com' });
    expect(normalizeHostname('WWW.Reddit.com')).toEqual({ ok: true, hostname: 'reddit.com' });
    expect(normalizeHostname('www.old.reddit.com')).toEqual({ ok: true, hostname: 'old.reddit.com' });
    expect(normalizeHostname('www.com')).toEqual({ ok: true, hostname: 'www.com' });
  });

  it('strips ports and trailing dots', () => {
    expect(normalizeHostname('reddit.com:8080')).toEqual({ ok: true, hostname: 'reddit.com' });
    expect(normalizeHostname('reddit.com.')).toEqual({ ok: true, hostname: 'reddit.com' });
  });

  it('canonicalizes unicode domains to punycode', () => {
    const expected = new URL('https://exämple.com').hostname;
    const result = normalizeHostname('exämple.com');
    expect(result.ok).toBe(true);
    expect(result.hostname).toBe(expected);
    expect(result.hostname).toMatch(/^xn--/);
  });

  it('accepts single-label hosts', () => {
    expect(normalizeHostname('localhost')).toEqual({ ok: true, hostname: 'localhost' });
  });

  it('rejects invalid input', () => {
    for (const bad of ['', '   ', 'has space.com', '-bad.com', `a${'x'.repeat(63)}.com`, 'not a url at all!', undefined, 42]) {
      expect(normalizeHostname(bad).ok).toBe(false);
    }
  });

  it('rejects empty labels', () => {
    expect(normalizeHostname('foo..com').ok).toBe(false);
  });
});

describe('hostSpecsForGroup', () => {
  it('combines base host, explicit subdomains and wildcard', () => {
    const specs = hostSpecsForGroup({
      domain: 'reddit.com',
      includeBaseHost: true,
      includeAllSubdomains: true,
      subdomains: ['old.reddit.com'],
    });
    expect(specs).toEqual([
      { kind: 'exact', host: 'reddit.com' },
      { kind: 'exact', host: 'old.reddit.com' },
      { kind: 'wildcard', base: 'reddit.com' },
    ]);
  });

  it('returns empty for empty groups', () => {
    expect(hostSpecsForGroup(null)).toEqual([]);
    expect(hostSpecsForGroup({ domain: 'x.com' })).toEqual([]);
  });
});

describe('hostnameMatchesSpec (www-tolerant semantics)', () => {
  it('exact host matches itself and the www twin', () => {
    const spec = { kind: 'exact', host: 'reddit.com' };
    expect(hostnameMatchesSpec('reddit.com', spec)).toBe(true);
    expect(hostnameMatchesSpec('www.reddit.com', spec)).toBe(true);
    expect(hostnameMatchesSpec('old.reddit.com', spec)).toBe(false);
    expect(hostnameMatchesSpec('www.old.reddit.com', spec)).toBe(false);
    expect(hostnameMatchesSpec('evilreddit.com', spec)).toBe(false);
  });

  it('a www-prefixed spec matches both spellings', () => {
    const spec = { kind: 'exact', host: 'www.reddit.com' };
    expect(hostnameMatchesSpec('www.reddit.com', spec)).toBe(true);
    expect(hostnameMatchesSpec('reddit.com', spec)).toBe(true);
    expect(hostnameMatchesSpec('old.reddit.com', spec)).toBe(false);
    expect(hostnameMatchesSpec('www.old.reddit.com', { kind: 'exact', host: 'old.reddit.com' })).toBe(true);
  });

  it('wildcard matches subdomains of any depth but not the bare domain', () => {
    const spec = { kind: 'wildcard', base: 'reddit.com' };
    expect(hostnameMatchesSpec('old.reddit.com', spec)).toBe(true);
    expect(hostnameMatchesSpec('a.b.reddit.com', spec)).toBe(true);
    expect(hostnameMatchesSpec('www.reddit.com', spec)).toBe(true);
    expect(hostnameMatchesSpec('reddit.com', spec)).toBe(false);
    expect(hostnameMatchesSpec('notreddit.com', spec)).toBe(false);
    expect(hostnameMatchesSpec('reddit.com.evil.io', spec)).toBe(false);
  });
});

describe('matchGroupForUrl', () => {
  const mkConfig = (groups) => ({ groups });

  it('finds a matching group', () => {
    const config = mkConfig([
      { id: 'g1', domain: 'reddit.com', includeBaseHost: true, level: 'total', subdomains: [], whitelist: [] },
    ]);
    const match = matchGroupForUrl('https://reddit.com/r/all', config);
    expect(match.group.id).toBe('g1');
  });

  it('ignores non-matching URLs', () => {
    const config = mkConfig([
      { id: 'g1', domain: 'reddit.com', includeBaseHost: true, level: 'total', subdomains: [], whitelist: [] },
    ]);
    expect(matchGroupForUrl('https://example.com/', config)).toBeNull();
    expect(matchGroupForUrl('not a url', config)).toBeNull();
    expect(matchGroupForUrl('ftp://reddit.com/', config)).toBeNull();
  });

  it('exact host beats wildcard from another group', () => {
    const config = mkConfig([
      { id: 'wild', domain: 'reddit.com', includeAllSubdomains: true, level: 'total', subdomains: [], whitelist: [] },
      { id: 'exact', domain: 'old.reddit.com', includeBaseHost: true, level: 'partial', subdomains: [], whitelist: [] },
    ]);
    const match = matchGroupForUrl('https://old.reddit.com/x', config);
    expect(match.group.id).toBe('exact');
  });

  it('at equal specificity total-block wins over partial', () => {
    const config = mkConfig([
      { id: 'partial', domain: 'old.reddit.com', includeBaseHost: true, level: 'partial', subdomains: [], whitelist: [] },
      { id: 'total', domain: 'old.reddit.com', includeBaseHost: true, level: 'total', subdomains: [], whitelist: [] },
    ]);
    const match = matchGroupForUrl('https://old.reddit.com/x', config);
    expect(match.group.id).toBe('total');
  });

  it('matches wildcards through any depth and handles ports and case', () => {
    const config = mkConfig([
      { id: 'g1', domain: 'Reddit.com', includeAllSubdomains: true, level: 'total', subdomains: [], whitelist: [] },
    ]);
    expect(matchGroupForUrl('https://a.b.reddit.com:8080/x?y=1#z', config).group.id).toBe('g1');
    expect(matchGroupForUrl('http://reddit.com.evil.io/', config)).toBeNull();
  });
});

describe('compilePathGlob and pathMatchesGlob', () => {
  it('no-star globs match the exact path or deeper directory paths', () => {
    expect(pathMatchesGlob('/mail', '/mail')).toBe(true);
    expect(pathMatchesGlob('/mail/u/0', '/mail')).toBe(true);
    expect(pathMatchesGlob('/mailbox', '/mail')).toBe(false);
    expect(pathMatchesGlob('/mailx/inbox', '/mail')).toBe(false);
  });

  it('star globs match freely', () => {
    expect(pathMatchesGlob('/r/learnprogramming', '/r/learn*')).toBe(true);
    expect(pathMatchesGlob('/r/learn', '/r/learn*')).toBe(true);
    expect(pathMatchesGlob('/r/gaming', '/r/learn*')).toBe(false);
  });

  it('root glob matches every path', () => {
    expect(pathMatchesGlob('/anything/here', '/')).toBe(true);
  });

  it('query and fragment parts are stripped from globs', () => {
    const compiled = compilePathGlob('/mail?inbox=1');
    expect(compiled.ok).toBe(true);
    expect(compiled.normalized).toBe('/mail');
  });

  it('rejects invalid globs', () => {
    expect(compilePathGlob('mail').ok).toBe(false);
    expect(compilePathGlob('').ok).toBe(false);
    expect(compilePathGlob(`/${'a'.repeat(200)}`).ok).toBe(false);
    expect(compilePathGlob('/bad\npath').ok).toBe(false);
  });

  it('accepts a pasted URL or host+path without a scheme', () => {
    expect(compilePathGlob('https://reddit.com/r/learn*')).toEqual({
      ok: true, source: '/r/learn.*', exactPrefix: false, normalized: '/r/learn*',
    });
    expect(compilePathGlob('http://reddit.com/mail')).toMatchObject({ ok: true, normalized: '/mail' });
    expect(compilePathGlob('www.reddit.com/r/learn')).toMatchObject({ ok: true, normalized: '/r/learn' });
    expect(compilePathGlob('reddit.com:8080/r/learn?x=1#top')).toMatchObject({ ok: true, normalized: '/r/learn' });
  });

  it('refuses a pasted URL with no path', () => {
    expect(compilePathGlob('https://reddit.com').ok).toBe(false);
    expect(compilePathGlob('reddit.com').ok).toBe(false);
  });
});

describe('isWhitelistedUrl', () => {
  const group = { whitelist: ['/mail', '/r/learn*'] };
  it('matches whitelisted paths', () => {
    expect(isWhitelistedUrl(new URL('https://reddit.com/mail/u/0'), group)).toBe(true);
    expect(isWhitelistedUrl(new URL('https://reddit.com/r/learnpython'), group)).toBe(true);
  });
  it('does not match other paths or empty whitelists', () => {
    expect(isWhitelistedUrl(new URL('https://reddit.com/r/gaming'), group)).toBe(false);
    expect(isWhitelistedUrl(new URL('https://reddit.com/mail'), { whitelist: [] })).toBe(false);
    expect(isWhitelistedUrl(new URL('https://reddit.com/mail'), {})).toBe(false);
  });
});

describe('regex sources', () => {
  it('exact host regex matches the host with or without www, any port and path', () => {
    const re = new RegExp(`^(${exactHostsRegexSource(['reddit.com', 'old.reddit.com'])})$`);
    expect(re.test('https://reddit.com')).toBe(true);
    expect(re.test('https://reddit.com/')).toBe(true);
    expect(re.test('https://reddit.com:8080/r/x')).toBe(true);
    expect(re.test('http://old.reddit.com/r/x')).toBe(true);
    expect(re.test('https://www.reddit.com/')).toBe(true);
    expect(re.test('http://www.reddit.com/r/x')).toBe(true);
    expect(re.test('https://www.old.reddit.com/r/x')).toBe(true);
    expect(re.test('https://evilreddit.com/')).toBe(false);
    expect(re.test('https://reddit.com.evil.io/')).toBe(false);
    expect(re.test('https://www.reddit.com.evil.io/')).toBe(false);
    expect(re.test('https://old.reddit.com.evil.io/')).toBe(false);
  });

  it('www-prefixed hosts from a legacy config normalize into the same alternation', () => {
    const re = new RegExp(`^(${exactHostsRegexSource(['www.reddit.com'])})$`);
    expect(re.test('https://www.reddit.com/r/x')).toBe(true);
    expect(re.test('https://reddit.com/r/x')).toBe(true);
  });

  it('wildcard regex matches subdomains only', () => {
    const re = new RegExp(`^(${wildcardHostRegexSource('reddit.com')})$`);
    expect(re.test('https://old.reddit.com/')).toBe(true);
    expect(re.test('https://a.b.reddit.com/')).toBe(true);
    expect(re.test('https://www.reddit.com/')).toBe(true);
    expect(re.test('https://reddit.com/')).toBe(false);
    expect(re.test('https://xreddit.com/')).toBe(false);
    expect(re.test('https://.reddit.com/')).toBe(false);
  });

  it('host-only sources stop after the host', () => {
    const exact = new RegExp(`^${exactHostsHostOnly(['reddit.com'])}$`);
    expect(exact.test('https://reddit.com')).toBe(true);
    expect(exact.test('https://reddit.com/x')).toBe(false);
    const wild = new RegExp(`^${wildcardHostOnly('reddit.com')}$`);
    expect(wild.test('https://old.reddit.com')).toBe(true);
    expect(wild.test('https://old.reddit.com/x')).toBe(false);
  });
});

describe('groupMatchPatterns', () => {
  it('builds tab query patterns for a group', () => {
    const patterns = groupMatchPatterns({
      domain: 'reddit.com',
      includeBaseHost: true,
      includeAllSubdomains: true,
      subdomains: ['old.reddit.com'],
    });
    expect(patterns).toEqual([
      '*://reddit.com/*',
      '*://www.reddit.com/*',
      '*://old.reddit.com/*',
      '*://www.old.reddit.com/*',
      '*://*.reddit.com/*',
    ]);
  });
});
