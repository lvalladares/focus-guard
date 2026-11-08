(function () {
  'use strict';

  if (typeof FocusOverlay === 'undefined') return;
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  if (window.top !== window) return;

  try {
    FocusOverlay.create({
      chrome: chrome,
      document: document,
      location: location,
      blockedPageUrl: function () {
        return chrome.runtime.getURL('/src/pages/blocked/blocked.html');
      },
    });
  } catch {
    /* extension context unavailable */
  }
})();
