import { describe, it, expect } from 'vitest';
import { createConfigStorage, createSplitStorage, blockKey, blockStateKey } from '../src/lib/config-storage.js';
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
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) delete data[key];
    },
  };
}

const CONFIG = STORAGE_KEYS.CONFIG;
const RUNTIME = STORAGE_KEYS.RUNTIME;

describe('createConfigStorage', () => {
  it('stores and reassembles split block keys in sync storage', async () => {
    const sync = makeStorage();
    const configStorage = createConfigStorage({ sync, local: makeStorage() });
    const cfg = {
      schemaVersion: 3,
      master: { enabled: false },
      blocks: [
        { id: 'b1', name: 'Block 1', sites: [] },
        { id: 'b2', name: 'Block 2', sites: [] },
      ],
    };
    await configStorage.setConfig(cfg);
    expect(sync.data[CONFIG]).toEqual({ schemaVersion: 3, master: { enabled: false }, blockIds: ['b1', 'b2'] });
    expect(sync.data[blockKey('b1')]).toEqual({ id: 'b1', name: 'Block 1', sites: [] });
    expect(sync.data[blockKey('b2')]).toEqual({ id: 'b2', name: 'Block 2', sites: [] });
    expect(await configStorage.getConfig()).toEqual(cfg);
  });

  it('removes orphaned block config and block state keys when a block is deleted', async () => {
    const sync = makeStorage({
      [blockStateKey('b2')]: { snooze: null, snoozeHistory: [100], usageWindow: null, updatedAt: 100 },
    });
    const configStorage = createConfigStorage({ sync, local: makeStorage() });
    await configStorage.setConfig({
      schemaVersion: 3,
      blocks: [{ id: 'b1', name: 'B1' }, { id: 'b2', name: 'B2' }],
    });
    await configStorage.setConfig({
      schemaVersion: 3,
      blocks: [{ id: 'b1', name: 'B1' }],
    });
    expect(sync.data[blockKey('b2')]).toBeUndefined();
    expect(sync.data[blockStateKey('b2')]).toBeUndefined();
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
  });

  it('returns null when nothing is stored anywhere', async () => {
    const configStorage = createConfigStorage({ sync: makeStorage(), local: makeStorage() });
    expect(await configStorage.getConfig()).toBeNull();
  });

  it('serializes per-block state updates cleanly', async () => {
    const sync = makeStorage();
    const configStorage = createConfigStorage({ sync, local: makeStorage() });
    await Promise.all([
      configStorage.updateBlockState('b1', (s) => ({ ...s, snoozeHistory: [...s.snoozeHistory, 1000] })),
      configStorage.updateBlockState('b1', (s) => ({ ...s, snoozeHistory: [...s.snoozeHistory, 2000] })),
    ]);
    const state = await configStorage.getBlockState('b1');
    expect(state.snoozeHistory).toEqual([1000, 2000]);
  });
});

describe('createSplitStorage', () => {
  it('routes config and blockStates to sync and runtime to local', async () => {
    const sync = makeStorage({
      [CONFIG]: { schemaVersion: 3, blockIds: ['b1'] },
      [blockKey('b1')]: { id: 'b1', name: 'One', sites: [] },
      [blockStateKey('b1')]: { snooze: null, snoozeHistory: [1234], usageWindow: null, updatedAt: 1234 },
    });
    const local = makeStorage({ [RUNTIME]: { override: null } });
    const storage = createSplitStorage({ sync, local });
    const result = await storage.get([CONFIG, 'blockStates', RUNTIME]);
    expect(result[CONFIG].blocks).toEqual([{ id: 'b1', name: 'One', sites: [] }]);
    expect(result.blockStates.b1.snoozeHistory).toEqual([1234]);
    expect(result[RUNTIME]).toEqual({ override: null });
  });
});
