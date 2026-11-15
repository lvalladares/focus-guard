import { STORAGE_KEYS } from './constants.js';
import { emptyBlockState, normalizeBlockState } from './sessions.js';

export function blockKey(blockId) {
  return `${STORAGE_KEYS.BLOCK_PREFIX}${blockId}`;
}

export function blockStateKey(blockId) {
  return `${STORAGE_KEYS.BLOCK_STATE_PREFIX}${blockId}`;
}

export function createConfigStorage({ sync, local }) {
  const blockQueues = new Map();

  function serializeBlockOp(blockId, task) {
    const prev = blockQueues.get(blockId) || Promise.resolve();
    const run = prev.then(task, task);
    blockQueues.set(blockId, run.catch(() => {}));
    return run;
  }

  async function hydrateConfigFromSync(meta) {
    if (!meta || !Array.isArray(meta.blockIds)) return meta;
    const keys = meta.blockIds.map(blockKey);
    const blockStore = keys.length > 0 ? await sync.get(keys) : {};
    const blocks = meta.blockIds
      .map((id) => blockStore[blockKey(id)])
      .filter(Boolean);
    const { blockIds: _ignored, ...rest } = meta;
    return { ...rest, blocks };
  }

  async function getConfig() {
    const store = await sync.get([STORAGE_KEYS.CONFIG]);
    if (store[STORAGE_KEYS.CONFIG]) {
      return hydrateConfigFromSync(store[STORAGE_KEYS.CONFIG]);
    }
    const localStore = await local.get([STORAGE_KEYS.CONFIG]);
    const localConfig = localStore[STORAGE_KEYS.CONFIG];
    if (localConfig) {
      await setConfig(localConfig);
      return localConfig;
    }
    return null;
  }

  async function setConfig(config) {
    if (!config || !Array.isArray(config.blocks)) {
      await sync.set({ [STORAGE_KEYS.CONFIG]: config });
      return;
    }
    const prevStore = await sync.get([STORAGE_KEYS.CONFIG]);
    const prevMeta = prevStore[STORAGE_KEYS.CONFIG];
    const prevIds = prevMeta && Array.isArray(prevMeta.blockIds) ? prevMeta.blockIds : [];

    const { blocks, ...meta } = config;
    const blockIds = blocks.map((b) => b.id);
    const writes = {
      [STORAGE_KEYS.CONFIG]: { ...meta, blockIds },
    };
    for (const block of blocks) {
      writes[blockKey(block.id)] = block;
    }
    await sync.set(writes);

    const nextSet = new Set(blockIds);
    const staleIds = prevIds.filter((id) => !nextSet.has(id));
    if (staleIds.length > 0 && typeof sync.remove === 'function') {
      const staleKeys = [];
      for (const id of staleIds) {
        staleKeys.push(blockKey(id), blockStateKey(id));
      }
      await sync.remove(staleKeys);
    }
  }

  async function getBlockStates(blockIds) {
    if (!Array.isArray(blockIds) || blockIds.length === 0) return {};
    const keys = blockIds.map(blockStateKey);
    const store = await sync.get(keys);
    const out = {};
    for (const id of blockIds) {
      out[id] = store[blockStateKey(id)]
        ? normalizeBlockState(store[blockStateKey(id)])
        : emptyBlockState();
    }
    return out;
  }

  async function getBlockState(blockId) {
    const store = await sync.get([blockStateKey(blockId)]);
    return store[blockStateKey(blockId)]
      ? normalizeBlockState(store[blockStateKey(blockId)])
      : emptyBlockState();
  }

  async function setBlockState(blockId, state) {
    await sync.set({ [blockStateKey(blockId)]: normalizeBlockState(state) });
  }

  async function setBlockStates(statesById) {
    const writes = {};
    for (const [blockId, state] of Object.entries(statesById || {})) {
      writes[blockStateKey(blockId)] = normalizeBlockState(state);
    }
    if (Object.keys(writes).length > 0) {
      await sync.set(writes);
    }
  }

  function updateBlockState(blockId, updater) {
    return serializeBlockOp(blockId, async () => {
      const current = await getBlockState(blockId);
      const next = await updater(current);
      if (next && next !== current) {
        const normalized = normalizeBlockState(next);
        await sync.set({ [blockStateKey(blockId)]: normalized });
        return normalized;
      }
      return current;
    });
  }

  return {
    getConfig,
    setConfig,
    getBlockStates,
    getBlockState,
    setBlockState,
    setBlockStates,
    updateBlockState,
  };
}

export function createSplitStorage({ sync, local }) {
  const configStorage = createConfigStorage({ sync, local });

  async function get(keys) {
    const wants = (key) => !Array.isArray(keys) || keys.includes(key);
    const out = {};
    let config = null;
    if (wants(STORAGE_KEYS.CONFIG) || wants('blockStates')) {
      config = await configStorage.getConfig();
    }
    if (wants(STORAGE_KEYS.CONFIG) && config) {
      out[STORAGE_KEYS.CONFIG] = config;
    }
    if (wants('blockStates')) {
      const ids = config && Array.isArray(config.blocks) ? config.blocks.map((b) => b.id) : [];
      out.blockStates = await configStorage.getBlockStates(ids);
    }
    if (wants(STORAGE_KEYS.RUNTIME)) {
      const store = await local.get([STORAGE_KEYS.RUNTIME]);
      if (store[STORAGE_KEYS.RUNTIME]) out[STORAGE_KEYS.RUNTIME] = store[STORAGE_KEYS.RUNTIME];
    }
    return out;
  }

  return { get };
}
