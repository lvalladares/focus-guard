import { STORAGE_KEYS } from './constants.js';

export function createConfigStorage({ sync, local }) {
  async function getConfig() {
    const store = await sync.get(STORAGE_KEYS.CONFIG);
    if (store[STORAGE_KEYS.CONFIG]) return store[STORAGE_KEYS.CONFIG];
    const localStore = await local.get(STORAGE_KEYS.CONFIG);
    const localConfig = localStore[STORAGE_KEYS.CONFIG];
    if (localConfig) {
      await sync.set({ [STORAGE_KEYS.CONFIG]: localConfig });
      return localConfig;
    }
    return null;
  }

  async function setConfig(config) {
    await sync.set({ [STORAGE_KEYS.CONFIG]: config });
  }

  return { getConfig, setConfig };
}

export function createSplitStorage({ sync, local }) {
  const configStorage = createConfigStorage({ sync, local });

  async function get(keys) {
    const wants = (key) => !Array.isArray(keys) || keys.includes(key);
    const out = {};
    if (wants(STORAGE_KEYS.CONFIG)) {
      const config = await configStorage.getConfig();
      if (config) out[STORAGE_KEYS.CONFIG] = config;
    }
    if (wants(STORAGE_KEYS.RUNTIME)) {
      const store = await local.get(STORAGE_KEYS.RUNTIME);
      if (store[STORAGE_KEYS.RUNTIME]) out[STORAGE_KEYS.RUNTIME] = store[STORAGE_KEYS.RUNTIME];
    }
    return out;
  }

  return { get };
}
