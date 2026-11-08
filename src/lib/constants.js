export const FREE_TIME_OPTIONS = [10, 20, 30];
export const COOLDOWN_MS = 10 * 60 * 1000;
export const REFLECTION_SECONDS = 30;
export const WARNING_WINDOW_MS = 60 * 1000;

export const LEVELS = ['total', 'partial'];

export const STORAGE_KEYS = {
  CONFIG: 'focusConfig',
  RUNTIME: 'focusRuntime',
};

export const STATS = {
  DAY_KEY_PREFIX: 'focusStats:',
  META_KEY: 'focusStats:meta',
  OPEN_KEY: 'focusStatsOpen',
  DEFAULT_RETENTION_MONTHS: 12,
};

export const STATS_PERIODS = ['today', 'week', 'month', 'all'];

export const PAGES = {
  BLOCKED: '/src/pages/blocked/blocked.html',
  GATE: '/src/pages/gate/gate.html',
  SETTINGS: '/src/pages/settings/settings.html',
};
