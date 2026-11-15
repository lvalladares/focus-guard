import { describe, it, expect } from 'vitest';
import {
  defaultConfig,
  defaultBlock,
  normalizeConfig,
  newBlockId,
  newSiteId,
  isBlockLocked,
  hasActivePersistentBlock,
  validateLockedBlockChanges,
  CURRENT_SCHEMA_VERSION,
} from '../src/lib/config.js';

const MON_10 = new Date('2026-11-09T10:00:00').getTime();
const MON_20 = new Date('2026-11-09T20:00:00').getTime();

describe('defaultConfig', () => {
  it('starts with 3 named blocks and expected shape', () => {
    const cfg = defaultConfig();
    expect(cfg.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(cfg.master).toEqual({ enabled: false });
    expect(cfg.antiUninstall).toEqual({ enabled: false });
    expect(cfg.blocks).toHaveLength(3);
    expect(cfg.blocks.map((b) => b.name)).toEqual(['Block 1', 'Block 2', 'Block 3']);
    expect(cfg.blocks[0].enabled).toBe(true);
    expect(cfg.blocks[0].persistent).toBe(false);
    expect(cfg.blocks[0].sites).toEqual([]);
    expect(cfg.blocks[0].schedule).toEqual({ alwaysActive: false, windows: [] });
    expect(cfg.blocks[0].timeLimit).toEqual({ enabled: false, minutes: 20, periodHours: 8 });
    expect(cfg.blocks[0].snooze).toEqual({ enabled: false, durationMinutes: 5, maxCount: 1, periodHours: 4 });
  });
});

describe('legacy v1/v2 -> v3 migration', () => {
  it('migrates legacy groups and schedule into blocks', () => {
    const legacy = {
      schemaVersion: 2,
      master: { enabled: true },
      schedule: { windows: [{ days: [1], start: '09:00', end: '17:00' }] },
      groups: [
        { id: 'g1', domain: 'reddit.com', includeBaseHost: true, level: 'total' },
        { id: 'g2', domain: 'youtube.com', includeBaseHost: true, level: 'partial' },
      ],
      wallpaper: { mode: 'builtin', value: 'minimal' },
      stats: { enabled: true, retentionMonths: 12 },
    };
    const { config, errors } = normalizeConfig(legacy);
    expect(errors).toEqual([]);
    expect(config.schemaVersion).toBe(3);
    expect(config.master.enabled).toBe(true);
    expect(config.blocks).toHaveLength(3);
    expect(config.blocks[0].sites[0].domain).toBe('reddit.com');
    expect(config.blocks[0].snooze.enabled).toBe(false);
    expect(config.blocks[1].sites[0].domain).toBe('youtube.com');
    expect(config.blocks[1].snooze.enabled).toBe(true);
    expect(config.blocks[0].schedule.windows).toEqual([{ days: [1], start: 540, end: 1020, overnight: false }]);
  });
});

describe('normalizeConfig', () => {
  it('returns defaults for missing input', () => {
    const { config, errors } = normalizeConfig(undefined);
    expect(errors).toEqual([]);
    expect(config.blocks).toHaveLength(3);
    expect(config.antiUninstall).toEqual({ enabled: false });
  });

  it('preserves empty blocks array when user explicitly removes all blocks', () => {
    const { config, errors } = normalizeConfig({ blocks: [] });
    expect(errors).toEqual([]);
    expect(config.blocks).toEqual([]);
  });

  it('normalizes block names, sites, schedule, timeLimit and snooze', () => {
    const { config, errors } = normalizeConfig({
      antiUninstall: { enabled: true },
      blocks: [
        {
          id: 'b1',
          name: '  Social Media  ',
          enabled: true,
          persistent: true,
          sites: [
            { id: 's1', domain: ' Reddit.COM ', includeBaseHost: true, subdomains: [' OLD.Reddit.com ', 'old.reddit.com'], whitelist: ['/r/learn*'] },
          ],
          schedule: {
            alwaysActive: false,
            windows: [{ days: [1, 1, 2, 'x'], start: '09:00', end: '17:00' }],
          },
          timeLimit: { enabled: true, minutes: 20, periodHours: 8 },
          snooze: { enabled: true, durationMinutes: 5, maxCount: 2, periodHours: 4 },
        },
      ],
    });
    expect(errors).toEqual([]);
    expect(config.antiUninstall.enabled).toBe(true);
    expect(config.blocks[0]).toEqual({
      id: 'b1',
      name: 'Social Media',
      enabled: true,
      persistent: true,
      sites: [
        {
          id: 's1',
          domain: 'reddit.com',
          includeBaseHost: true,
          includeAllSubdomains: false,
          subdomains: ['old.reddit.com'],
          whitelist: ['/r/learn*'],
        },
      ],
      schedule: { alwaysActive: false, windows: [{ days: [1, 2], start: 540, end: 1020, overnight: false }] },
      timeLimit: { enabled: true, minutes: 20, periodHours: 8 },
      snooze: { enabled: true, durationMinutes: 5, maxCount: 2, periodHours: 4 },
    });
  });

  it('allows the same domain across different blocks while rejecting duplicates inside the same block', () => {
    const crossBlock = normalizeConfig({
      blocks: [
        { id: 'b1', name: 'Morning', sites: [{ domain: 'reddit.com', includeBaseHost: true }] },
        { id: 'b2', name: 'Afternoon', sites: [{ domain: 'reddit.com', includeBaseHost: true }] },
      ],
    });
    expect(crossBlock.errors).toEqual([]);

    const sameBlock = normalizeConfig({
      blocks: [
        {
          id: 'b1',
          name: 'Morning',
          sites: [
            { domain: 'reddit.com', includeBaseHost: true },
            { domain: 'reddit.com', includeBaseHost: true },
          ],
        },
      ],
    });
    expect(sameBlock.errors.some((e) => e.includes('already listed in this block'))).toBe(true);
  });

  it('validates invalid timeLimit and snooze ranges when enabled', () => {
    const { errors } = normalizeConfig({
      blocks: [
        {
          id: 'b1',
          name: 'Work',
          timeLimit: { enabled: true, minutes: 0, periodHours: 0 },
          snooze: { enabled: true, durationMinutes: 500, maxCount: 0, periodHours: 200 },
        },
      ],
    });
    expect(errors.length).toBe(5);
  });

  it('is idempotent', () => {
    const once = normalizeConfig({
      blocks: [
        {
          id: 'b1',
          name: 'Focus',
          sites: [{ id: 's1', domain: 'reddit.com', includeBaseHost: true }],
          schedule: { windows: [{ days: [1], start: '09:00', end: '17:00' }] },
          timeLimit: { enabled: true, minutes: 20, periodHours: 8 },
          snooze: { enabled: true, durationMinutes: 5, maxCount: 1, periodHours: 4 },
        },
      ],
    });
    const twice = normalizeConfig(once.config);
    expect(twice.config).toEqual(once.config);
  });
});

describe('persistent lock validation', () => {
  const lockedBlock = normalizeConfig({
    antiUninstall: { enabled: true },
    blocks: [
      {
        id: 'b_lock',
        name: 'Deep Work',
        enabled: true,
        persistent: true,
        sites: [{ id: 's1', domain: 'reddit.com', includeBaseHost: true }],
        schedule: { alwaysActive: false, windows: [{ days: [1], start: '09:00', end: '17:00' }] },
      },
      {
        id: 'b_free',
        name: 'Flexible',
        enabled: true,
        persistent: false,
        sites: [{ id: 's2', domain: 'news.com', includeBaseHost: true }],
        schedule: { alwaysActive: false, windows: [{ days: [1], start: '09:00', end: '17:00' }] },
      },
    ],
  }).config;

  it('detects locked blocks only when enabled, persistent, and inside schedule', () => {
    expect(isBlockLocked(lockedBlock.blocks[0], MON_10)).toBe(true);
    expect(isBlockLocked(lockedBlock.blocks[0], MON_20)).toBe(false);
    expect(isBlockLocked(lockedBlock.blocks[1], MON_10)).toBe(false);
    expect(hasActivePersistentBlock(lockedBlock, MON_10)).toBe(true);
    expect(hasActivePersistentBlock(lockedBlock, MON_20)).toBe(false);
  });

  it('blocks edits, disables, and deletions of active persistent blocks', () => {
    const modified = structuredClone(lockedBlock);
    modified.blocks[0].enabled = false;
    expect(validateLockedBlockChanges(lockedBlock, modified, MON_10).ok).toBe(false);

    const deleted = structuredClone(lockedBlock);
    deleted.blocks.shift();
    expect(validateLockedBlockChanges(lockedBlock, deleted, MON_10).ok).toBe(false);

    const unAntiUninstall = structuredClone(lockedBlock);
    unAntiUninstall.antiUninstall.enabled = false;
    expect(validateLockedBlockChanges(lockedBlock, unAntiUninstall, MON_10).ok).toBe(false);
  });

  it('allows editing non-persistent blocks while a persistent block is active, and editing persistent blocks outside hours', () => {
    const editNonPersistent = structuredClone(lockedBlock);
    editNonPersistent.blocks[1].enabled = false;
    expect(validateLockedBlockChanges(lockedBlock, editNonPersistent, MON_10).ok).toBe(true);

    const editOutsideHours = structuredClone(lockedBlock);
    editOutsideHours.blocks[0].persistent = false;
    editOutsideHours.antiUninstall.enabled = false;
    expect(validateLockedBlockChanges(lockedBlock, editOutsideHours, MON_20).ok).toBe(true);
  });
});

describe('id generators', () => {
  it('generates unique block and site ids', () => {
    expect(new Set(Array.from({ length: 50 }, () => newBlockId())).size).toBe(50);
    expect(new Set(Array.from({ length: 50 }, () => newSiteId())).size).toBe(50);
    expect(defaultBlock(0).name).toBe('Block 1');
  });
});
