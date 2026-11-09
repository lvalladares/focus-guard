import { describe, it, expect } from 'vitest';
import { createConfigStorage, createSplitStorage } from '../src/lib/config-storage.js';
import { STORAGE_KEYS } from '../src/lib/constants.js';

function makeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of list) {
        if (key in data) out[key] = data[key];
      }
      return out;
    },
    async set(writes) {
      Object.assign(data, writes);
    },
  };
}

const CONFIG = STORAGE_KEYS.CONFIG;
const RUNTIME = STORAGE_KEYS.RUNTIME;

describe('createConfigStorage', () => {
  it('reads config from sync storage', async () => {
    const sync = makeStorage({ [CONFIG]: { schemaVersion: 2 } });
    const local = makeStorage();
    const configStorage = createConfigStorage({ sync, local });
    expect(await configStorage.getConfig()).toEqual({ schemaVersion: 2 });
  });

  it('migrates a legacy local config to sync once and returns it', async () => {
    const sync = makeStorage();
    const local = makeStorage({ [CONFIG]: { schemaVersion: 1, groups: ['legacy'] } });
    const configStorage = createConfigStorage({ sync, local });
    const config = await configStorage.getConfig();
    expect(config).toEqual({ schemaVersion: 1, groups: ['legacy'] });
    expect(sync.data[CONFIG]).toEqual({ schemaVersion: 1, groups: ['legacy'] });
  });

  it('never overwrites an existing synced config with local data', async () => {
    const sync = makeStorage({ [CONFIG]: { schemaVersion: 2, fresh: true } });
    const local = makeStorage({ [CONFIG]: { schemaVersion: 1, stale: true } });
    const configStorage = createConfigStorage({ sync, local });
    expect(await configStorage.getConfig()).toEqual({ schemaVersion: 2, fresh: true });
    expect(sync.data[CONFIG]).toEqual({ schemaVersion: 2, fresh: true });
  });

  it('returns null when nothing is stored anywhere', async () => {
    const configStorage = createConfigStorage({ sync: makeStorage(), local: makeStorage() });
    expect(await configStorage.getConfig()).toBeNull();
  });

  it('writes config to sync storage', async () => {
    const sync = makeStorage();
    const configStorage = createConfigStorage({ sync, local: makeStorage() });
    await configStorage.setConfig({ hello: true });
    expect(sync.data[CONFIG]).toEqual({ hello: true });
  });
});

describe('createSplitStorage', () => {
  it('routes config to sync and runtime to local', async () => {
    const sync = makeStorage({ [CONFIG]: { groups: [] } });
    const local = makeStorage({ [RUNTIME]: { sessions: {} } });
    const storage = createSplitStorage({ sync, local });
    const result = await storage.get([CONFIG, RUNTIME]);
    expect(result).toEqual({
      [CONFIG]: { groups: [] },
      [RUNTIME]: { sessions: {} },
    });
  });

  it('only fetches requested keys', async () => {
    const sync = makeStorage({ [CONFIG]: { groups: [] } });
    const local = makeStorage({ [RUNTIME]: { sessions: {} } });
    const storage = createSplitStorage({ sync, local });
    expect(await storage.get([RUNTIME])).toEqual({ [RUNTIME]: { sessions: {} } });
    expect(await storage.get([CONFIG])).toEqual({ [CONFIG]: { groups: [] } });
  });

  it('falls back to a legacy local config and migrates it', async () => {
    const sync = makeStorage();
    const local = makeStorage({ [CONFIG]: { legacy: true }, [RUNTIME]: { sessions: {} } });
    const storage = createSplitStorage({ sync, local });
    const result = await storage.get([CONFIG, RUNTIME]);
    expect(result[CONFIG]).toEqual({ legacy: true });
    expect(sync.data[CONFIG]).toEqual({ legacy: true });
  });

  it('omits missing keys', async () => {
    const storage = createSplitStorage({ sync: makeStorage(), local: makeStorage() });
    expect(await storage.get([CONFIG, RUNTIME])).toEqual({});
  });
});
