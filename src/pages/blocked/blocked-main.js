import { createBlockedController } from './blocked.js';
import { wallpaperSrc } from '../../lib/wallpapers.js';
import { PAGES } from '../../lib/constants.js';
import { createSplitStorage } from '../../lib/config-storage.js';

createBlockedController({
  document,
  location: window.location,
  storage: createSplitStorage({ sync: chrome.storage.sync, local: chrome.storage.local }),
  now: () => Date.now(),
  navigate: (url) => window.location.replace(url),
  historyBack: () => {
    if (window.history.length > 1) window.history.back();
    else window.close();
  },
  settingsUrl: chrome.runtime.getURL(PAGES.SETTINGS),
  gateUrlOf: (target) => `${chrome.runtime.getURL(PAGES.GATE)}#${encodeURIComponent(target)}`,
  wallpaperFor: wallpaperSrc,
  subscribe: (fn) => {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') fn();
    });
  },
});
