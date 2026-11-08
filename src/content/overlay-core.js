(function (global) {
  'use strict';

  var RUNTIME_KEY = 'focusRuntime';
  var WARNING_WINDOW_MS = 60 * 1000;

  function formatDuration(ms) {
    var total = Math.max(0, Math.ceil(ms / 1000));
    var m = Math.floor(total / 60);
    var s = total % 60;
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
      chromeApi.storage.local.get([RUNTIME_KEY], function (store) {
        var runtime = store && store[RUNTIME_KEY];
        if (!runtime || !runtime.sessions) return;
        if (Object.keys(runtime.sessions).length === 0) return;
        if (!listening) {
          listening = true;
          try {
            chromeApi.storage.onChanged.addListener(onStorageChange);
          } catch {
            /* storage events unavailable */
          }
        }
        check();
      });
    }

    function onStorageChange(changes, area) {
      if (area !== 'local' || !changes[RUNTIME_KEY]) return;
      check();
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
      if (!response.active || !response.endsAt) {
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
        '</style>',
        '<div class="card">',
        '<span class="label">Free time</span>',
        '<div class="row"><span class="domain"></span><span class="time"></span></div>',
        '<button class="end" type="button">End session now</button>',
        '</div>',
      ].join('');
      doc.documentElement.appendChild(host);
      shadow.querySelector('.end').addEventListener('click', endSession);
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
        redirectToBlocked();
        return;
      }
      var shadow = host.shadowRoot;
      shadow.querySelector('.time').textContent = formatDuration(remaining);
      shadow.querySelector('.domain').textContent = session.domain || '';
      var card = shadow.querySelector('.card');
      card.classList.toggle('warn', remaining <= 10 * 1000);
    }

    function redirectToBlocked() {
      stopTimers();
      navigate(blockedPageUrl() + '#' + encodeURIComponent(location.href));
    }

    function endSession() {
      if (!session || !session.groupId) return;
      chromeApi.runtime.sendMessage({ type: 'session:end', groupId: session.groupId }, function () {
        if (chromeApi.runtime.lastError) return;
        redirectToBlocked();
      });
    }

    function destroy() {
      stopTimers();
      removeOverlay();
    }

    start();

    return { check: check, destroy: destroy, handleResponse: handleResponse };
  }

  global.FocusOverlay = { create: createFocusOverlay };
})(typeof window !== 'undefined' ? window : globalThis);
