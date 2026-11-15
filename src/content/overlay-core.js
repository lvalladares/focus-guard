(function (global) {
  'use strict';

  var RUNTIME_KEY = 'focusRuntime';
  var CONFIG_KEY = 'focusConfig';
  var BLOCK_PREFIX = 'focusBlock:';
  var BLOCK_STATE_PREFIX = 'focusBlockState:';
  var WARNING_WINDOW_MS = 60 * 1000;

  function formatDuration(ms) {
    var total = Math.max(0, Math.ceil(ms / 1000));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    if (h > 0) {
      return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    }
    return m + ':' + String(s).padStart(2, '0');
  }

  function createFocusOverlay(deps) {
    var chromeApi = deps.chrome;
    var doc = deps.document;
    var location = deps.location;
    var navigate = deps.navigate || function (url) { location.replace(url); };
    var now = deps.now || function () { return Date.now(); };
    var blockedPageUrl = deps.blockedPageUrl;
    var setIntervalFn = deps.setInterval || global.setInterval.bind(global);
    var setTimeoutFn = deps.setTimeout || global.setTimeout.bind(global);
    var clearIntervalFn = deps.clearInterval || global.clearInterval.bind(global);
    var clearTimeoutFn = deps.clearTimeout || global.clearTimeout.bind(global);

    var session = null;
    var host = null;
    var tickTimer = null;
    var showTimer = null;
    var listening = false;

    function start() {
      if (!listening) {
        listening = true;
        try {
          chromeApi.storage.onChanged.addListener(onStorageChange);
        } catch {
          /* storage events unavailable */
        }
        try {
          doc.addEventListener('visibilitychange', onVisibilityChange);
        } catch {
          /* visibility events unavailable */
        }
      }
      check();
    }

    function onVisibilityChange() {
      if (!doc.hidden) check();
    }

    function onStorageChange(changes, area) {
      if (!changes) return;
      var keys = Object.keys(changes);
      if (area === 'local') {
        if (keys.indexOf(RUNTIME_KEY) !== -1) check();
        return;
      }
      if (area === 'sync') {
        var relevant = keys.some(function (k) {
          return k === CONFIG_KEY
            || k.indexOf(BLOCK_PREFIX) === 0
            || k.indexOf(BLOCK_STATE_PREFIX) === 0;
        });
        if (relevant) check();
      }
    }

    function check() {
      chromeApi.runtime.sendMessage({ type: 'overlay:check', url: location.href }, function (response) {
        if (chromeApi.runtime.lastError) return;
        handleResponse(response || {});
      });
    }

    function stopTimers() {
      if (tickTimer) {
        clearIntervalFn(tickTimer);
        tickTimer = null;
      }
      if (showTimer) {
        clearTimeoutFn(showTimer);
        showTimer = null;
      }
    }

    function handleResponse(response) {
      stopTimers();
      if (!response || !response.active || !response.endsAt) {
        removeOverlay();
        return;
      }
      session = response;
      var remaining = response.endsAt - now();
      if (remaining <= 0) {
        redirectToBlocked();
        return;
      }
      if (remaining <= WARNING_WINDOW_MS) {
        showOverlay();
        tickTimer = setIntervalFn(updateOverlay, 500);
      } else {
        hideOverlay();
        showTimer = setTimeoutFn(function () {
          showOverlay();
          tickTimer = setIntervalFn(updateOverlay, 500);
          updateOverlay();
        }, remaining - WARNING_WINDOW_MS);
      }
      updateOverlay();
    }

    function ensureHost() {
      if (host) return;
      host = doc.createElement('div');
      host.id = 'focus-guard-overlay-host';
      host.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;';
      var shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = [
        '<style>',
        '.card{font-family:"Segoe UI",system-ui,sans-serif;background:rgba(10,14,24,0.93);color:#eef1f8;border:1px solid rgba(255,255,255,0.18);border-radius:14px;padding:14px 16px;display:flex;flex-direction:column;gap:4px;min-width:200px;box-shadow:0 14px 36px rgba(0,0,0,0.45);}',
        '.label{font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#7dd8ff;font-weight:700;}',
        '.row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;}',
        '.domain{font-size:13px;color:#9aa4bb;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.time{font-variant-numeric:tabular-nums;font-size:26px;font-weight:700;line-height:1;}',
        '.warn .time{color:#ff8f7a;}',
        '.warn .card{animation:fgpulse 1s ease-in-out infinite;}',
        '@keyframes fgpulse{50%{border-color:#ff8f7a;}}',
        '.end{appearance:none;border:none;background:transparent;color:#9aa4bb;font-size:11px;text-decoration:underline;cursor:pointer;padding:0;align-self:flex-end;}',
        '.end:hover{color:#ffffff;}',
        '.hidden{display:none;}',
        '</style>',
        '<div class="card">',
        '<span class="label">Free time</span>',
        '<div class="row"><span class="domain"></span><span class="time"></span></div>',
        '<button class="end" type="button">End snooze now</button>',
        '</div>',
      ].join('');
      doc.documentElement.appendChild(host);
      shadow.querySelector('.end').addEventListener('click', endSnooze);
    }

    function showOverlay() {
      ensureHost();
      host.style.display = '';
    }

    function hideOverlay() {
      ensureHost();
      host.style.display = 'none';
    }

    function removeOverlay() {
      session = null;
      if (host) {
        host.remove();
        host = null;
      }
    }

    function updateOverlay() {
      if (!session || !host) return;
      var remaining = session.endsAt - now();
      if (remaining <= 0) {
        if (session.mode === 'budget') {
          // Re-verify with background in case tab was briefly inactive or budget synced.
          check();
          return;
        }
        redirectToBlocked();
        return;
      }
      var shadow = host.shadowRoot;
      var label = session.mode === 'budget' ? 'Time limit' : 'Snooze';
      shadow.querySelector('.label').textContent = label;
      shadow.querySelector('.time').textContent = formatDuration(remaining);
      shadow.querySelector('.domain').textContent = session.blockName || session.domain || '';
      var endBtn = shadow.querySelector('.end');
      endBtn.classList.toggle('hidden', session.mode !== 'snooze');
      var card = shadow.querySelector('.card');
      card.classList.toggle('warn', remaining <= 10 * 1000);
    }

    function redirectToBlocked() {
      stopTimers();
      navigate(blockedPageUrl() + '#' + encodeURIComponent(location.href));
    }

    function endSnooze() {
      if (!session || !session.blockId || session.mode !== 'snooze') return;
      chromeApi.runtime.sendMessage({ type: 'snooze:end', blockId: session.blockId }, function () {
        if (chromeApi.runtime.lastError) return;
        redirectToBlocked();
      });
    }

    function destroy() {
      stopTimers();
      try {
        doc.removeEventListener('visibilitychange', onVisibilityChange);
      } catch {
        /* ignore */
      }
      removeOverlay();
    }

    start();

    return { check: check, destroy: destroy, handleResponse: handleResponse };
  }

  global.FocusOverlay = { create: createFocusOverlay };
})(typeof window !== 'undefined' ? window : globalThis);
