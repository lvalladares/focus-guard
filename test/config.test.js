import { describe, it, expect } from 'vitest';
import { defaultConfig, normalizeConfig, newGroupId } from '../src/lib/config.js';

describe('defaultConfig', () => {
  it('has the expected shape', () => {
    expect(defaultConfig()).toEqual({
      schemaVersion: 1,
      master: { enabled: false },
      schedule: { windows: [] },
      groups: [],
      wallpaper: { mode: 'builtin', value: 'aurora' },
    });
  });
});

describe('normalizeConfig', () => {
  it('returns defaults for missing input', () => {
    const { config, errors } = normalizeConfig(undefined);
    expect(errors).toEqual([]);
    expect(config).toEqual(defaultConfig());
  });

  it('normalizes group domains and levels', () => {
    const { config, errors } = normalizeConfig({
      groups: [{ id: 'g1', domain: ' Reddit.COM ', includeBaseHost: true, level: 'total', subdomains: [' OLD.Reddit.com ', 'old.reddit.com'], whitelist: [] }],
    });
    expect(errors).toEqual([]);
    expect(config.groups).toEqual([
      { id: 'g1', domain: 'reddit.com', includeBaseHost: true, includeAllSubdomains: false, subdomains: ['old.reddit.com'], whitelist: [], level: 'total' },
    ]);
  });

  it('defaults level to partial and generates ids', () => {
    const { config } = normalizeConfig({ groups: [{ domain: 'x.com', includeBaseHost: true }] });
    expect(config.groups[0].level).toBe('partial');
    expect(config.groups[0].id).toMatch(/^g_/);
  });

  it('drops groups with invalid domains and reports errors', () => {
    const { config, errors } = normalizeConfig({
      groups: [{ domain: 'not valid', includeBaseHost: true }, { domain: 'good.com', includeBaseHost: true }],
    });
    expect(config.groups).toHaveLength(1);
    expect(config.groups[0].domain).toBe('good.com');
    expect(errors.some((e) => e.includes('groups[0]'))).toBe(true);
  });

  it('flags groups with nothing to block', () => {
    const { errors } = normalizeConfig({ groups: [{ domain: 'x.com' }] });
    expect(errors.some((e) => e.includes('nothing to block'))).toBe(true);
  });

  it('drops invalid subdomains and whitelist globs with errors', () => {
    const { config, errors } = normalizeConfig({
      groups: [{ domain: 'x.com', includeBaseHost: true, subdomains: ['ok.x.com', 'bad host'], whitelist: ['/fine', 'nofrontslash'] }],
    });
    expect(config.groups[0].subdomains).toEqual(['ok.x.com']);
    expect(config.groups[0].whitelist).toEqual(['/fine']);
    expect(errors).toHaveLength(2);
  });

  it('rejects duplicate host scopes across groups', () => {
    const { errors } = normalizeConfig({
      groups: [
        { domain: 'reddit.com', includeBaseHost: true },
        { domain: 'reddit.com', includeBaseHost: true },
      ],
    });
    expect(errors.some((e) => e.includes('already blocked by another group'))).toBe(true);
  });

  it('rejects duplicate wildcard scopes across groups', () => {
    const { errors } = normalizeConfig({
      groups: [
        { domain: 'reddit.com', includeAllSubdomains: true },
        { domain: 'reddit.com', includeAllSubdomains: true },
      ],
    });
    expect(errors.some((e) => e.includes('Wildcard'))).toBe(true);
  });

  it('normalizes schedule windows', () => {
    const { config } = normalizeConfig({ schedule: { windows: [{ days: [1, 1, 2, 'x'], start: '09:00', end: '17:00' }] } });
    expect(config.schedule.windows).toEqual([{ days: [1, 2], start: 540, end: 1020, overnight: false }]);
  });

  it('validates wallpaper config', () => {
    const bad = normalizeConfig({ wallpaper: { mode: 'url', value: 'javascript:alert(1)' } });
    expect(bad.config.wallpaper.mode).toBe('builtin');
    expect(bad.errors).toHaveLength(1);

    const good = normalizeConfig({ wallpaper: { mode: 'url', value: 'https://example.com/bg.jpg' } });
    expect(good.config.wallpaper).toEqual({ mode: 'url', value: 'https://example.com/bg.jpg' });

    const unknown = normalizeConfig({ wallpaper: { mode: 'builtin', value: 'nope' } });
    expect(unknown.config.wallpaper.value).toBe('aurora');
  });

  it('is idempotent', () => {
    const once = normalizeConfig({
      groups: [{ domain: 'reddit.com', includeBaseHost: true, level: 'total' }],
      schedule: { windows: [{ days: [1], start: '09:00', end: '17:00' }] },
    });
    const twice = normalizeConfig(once.config);
    expect(twice.config).toEqual(once.config);
  });
});

describe('newGroupId', () => {
  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newGroupId()));
    expect(ids.size).toBe(100);
  });
});
