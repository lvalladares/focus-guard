import { createGateController } from './gate.js';
import { wallpaperSrc } from '../../lib/wallpapers.js';
import { PAGES } from '../../lib/constants.js';

createGateController({
  document,
  location: window.location,
  storage: chrome.storage.local,
  now: () => Date.now(),
  navigate: (url) => window.location.replace(url),
  historyBack: () => {
    if (window.history.length > 1) window.history.back();
    else window.close();
  },
  sendMessage: (msg) => new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response);
    });
  }),
  blockedUrlOf: (target) => `${chrome.runtime.getURL(PAGES.BLOCKED)}#${encodeURIComponent(target)}`,
  wallpaperFor: wallpaperSrc,
});
