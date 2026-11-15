import { evaluate } from '../../lib/decision.js';
import { parseHashTarget, safeParseUrl } from '../../lib/url.js';
import { formatDuration, formatClockTime } from '../../lib/format.js';
import { randomQuoteIndex, QUOTES } from '../../lib/quotes.js';
import { defaultConfig, normalizeConfig } from '../../lib/config.js';
import { STORAGE_KEYS } from '../../lib/constants.js';

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function createBlockedController(deps) {
  const {
    document,
    location,
    storage,
    now,
    navigate,
    historyBack,
    sendMessage,
    settingsUrl,
    wallpaperFor,
    subscribe,
    setInterval: setInt = setInterval,
    clearInterval: clearInt = clearInterval,
  } = deps;

  const els = {
    wallpaper: document.getElementById('wallpaper-img'),
    headline: document.getElementById('headline'),
    detail: document.getElementById('detail'),
    countdown: document.getElementById('countdown'),
    countdownNote: document.getElementById('countdown-note'),
    warning: document.getElementById('snooze-warning'),
    quote: document.getElementById('quote'),
    quoteAuthor: document.getElementById('quote-author'),
    back: document.getElementById('btn-back'),
    continueBtn: document.getElementById('btn-continue'),
    snooze: document.getElementById('btn-snooze'),
    settings: document.getElementById('btn-settings'),
  };

  let state = { config: defaultConfig(), blockStates: {}, runtime: { override: null } };
  let countdownTimer = null;
  let lastQuoteIndex = -1;
  let target = null;
  let currentSnoozableIds = [];

  function stopCountdown() {
    if (countdownTimer) {
      clearInt(countdownTimer);
      countdownTimer = null;
    }
  }

  function show(el, visible) {
    if (el) el.classList.toggle('hidden', !visible);
  }

  function renderQuote() {
    lastQuoteIndex = randomQuoteIndex(lastQuoteIndex);
    const quote = QUOTES[lastQuoteIndex];
    if (quote) {
      els.quote.textContent = `“${quote.text}”`;
      els.quoteAuthor.textContent = quote.author;
    }
  }

  async function refresh() {
    const store = await storage.get([STORAGE_KEYS.CONFIG, 'blockStates', STORAGE_KEYS.RUNTIME]);
    const config = normalizeConfig(store[STORAGE_KEYS.CONFIG]).config;
    const blockStates = store.blockStates || {};
    const runtime = store[STORAGE_KEYS.RUNTIME] || { override: null };
    state = { config, blockStates, runtime };
    render();
  }

  function targetHostLabel(url) {
    const parsed = safeParseUrl(url);
    return parsed ? parsed.hostname : url;
  }

  function render() {
    stopCountdown();
    renderQuote();
    els.wallpaper.src = wallpaperFor(state.config);
    els.settings.href = settingsUrl;
    if (els.warning) {
      els.warning.textContent = '';
      show(els.warning, false);
    }
    target = parseHashTarget(location.hash);
    currentSnoozableIds = [];

    if (!target) {
      els.headline.textContent = 'Nothing to block here';
      els.detail.textContent = 'You opened the Focus Guard block page directly. Configure your focus blocks in Settings and keep your focus where it matters.';
      show(els.countdown, false);
      show(els.countdownNote, false);
      show(els.continueBtn, false);
      show(els.snooze, false);
      return;
    }

    const result = evaluate({
      url: target,
      now: now(),
      config: state.config,
      runtime: state.runtime,
      blockStates: state.blockStates,
    });

    if (result.verdict === 'block-anti-uninstall') {
      els.headline.textContent = 'Extensions page is locked';
      els.detail.innerHTML = 'Anti-uninstall protection is active while a <strong>persistent block</strong> is running.';
      show(els.countdown, false);
      show(els.countdownNote, false);
      show(els.continueBtn, false);
      show(els.snooze, false);
      return;
    }

    const host = escapeHtml(targetHostLabel(target));
    const blockName = result.primaryBlock ? escapeHtml(result.primaryBlock.name) : '';
    const endsHint = result.blockEndAt
      ? ` Focus hours end at <strong>${formatClockTime(result.blockEndAt)}</strong>.`
      : '';

    if (result.verdict === 'block-snoozable') {
      const primary = result.snoozableBlocks[0];
      const rt = primary.rt;
      currentSnoozableIds = result.snoozableBlocks.map((s) => s.block.id);
      const minDuration = Math.min(...result.snoozableBlocks.map((s) => s.rt.snoozeDurationMinutes));

      els.headline.textContent = result.reason === 'budget-exhausted'
        ? 'Time limit reached'
        : 'This site is blocked';
      const budgetNote = result.reason === 'budget-exhausted'
        ? `You have used up your allowed time for <strong>${blockName}</strong>.`
        : `<strong>${host}</strong> is blocked by <strong>${blockName}</strong>.`;
      els.detail.innerHTML = `${budgetNote}${endsHint}`;

      els.snooze.textContent = `Snooze ${minDuration} min (${rt.snoozesLeft}/${rt.snoozeMax} left)`;
      els.snooze.disabled = false;
      show(els.snooze, true);
      show(els.continueBtn, false);

      if (result.nextUnlockAt && result.nextUnlockAt > now()) {
        els.countdownNote.textContent = 'Time limit resets in:';
        show(els.countdown, true);
        show(els.countdownNote, true);
        startCountdown(result.nextUnlockAt - now());
      } else {
        show(els.countdown, false);
        show(els.countdownNote, false);
      }
      return;
    }

    if (result.verdict === 'block') {
      show(els.snooze, false);
      show(els.continueBtn, false);

      if (result.reason === 'snoozes-exhausted') {
        els.headline.textContent = 'No snoozes left';
        els.detail.innerHTML = `You have used all snoozes for <strong>${blockName}</strong> (${host}).${endsHint}`;
      } else if (result.reason === 'budget-exhausted') {
        els.headline.textContent = 'Time limit reached';
        els.detail.innerHTML = `You have used up your allowed time for <strong>${blockName}</strong> (${host}).${endsHint}`;
      } else {
        els.headline.textContent = 'This site is blocked';
        els.detail.innerHTML = `<strong>${host}</strong> is blocked by <strong>${blockName}</strong>.${endsHint}`;
      }

      if (result.nextUnlockAt && result.nextUnlockAt > now()) {
        els.countdownNote.textContent = result.reason === 'snoozes-exhausted'
          ? 'Next snooze or reset in:'
          : 'Time limit resets in:';
        show(els.countdown, true);
        show(els.countdownNote, true);
        startCountdown(result.nextUnlockAt - now());
      } else {
        show(els.countdown, false);
        show(els.countdownNote, false);
      }
      return;
    }

    els.headline.textContent = 'You are free to continue';
    els.detail.innerHTML = `Blocking is currently off for <strong>${host}</strong>. Enjoy — and get back to it when the focus window returns.`;
    show(els.countdown, false);
    show(els.countdownNote, false);
    show(els.continueBtn, true);
    show(els.snooze, false);
  }

  function startCountdown(remainingMs) {
    const until = now() + remainingMs;
    const update = () => {
      const remaining = until - now();
      if (remaining <= 0) {
        stopCountdown();
        refresh();
        return;
      }
      els.countdown.textContent = formatDuration(remaining);
    };
    update();
    countdownTimer = setInt(update, 500);
  }

  async function onSnoozeClick() {
    if (!target || currentSnoozableIds.length === 0 || !sendMessage) return;
    els.snooze.disabled = true;
    if (els.warning) {
      els.warning.textContent = '';
      show(els.warning, false);
    }
    try {
      const response = await sendMessage({
        type: 'snooze:start',
        blockIds: currentSnoozableIds,
        targetUrl: target,
      });
      if (response && response.ok) {
        navigate(target);
        return;
      }
      if (els.warning) {
        els.warning.textContent = (response && response.error) || 'Could not activate snooze.';
        show(els.warning, true);
      }
      await refresh();
    } catch {
      if (els.warning) {
        els.warning.textContent = 'Could not activate snooze.';
        show(els.warning, true);
      }
      els.snooze.disabled = false;
    }
  }

  els.back.addEventListener('click', () => historyBack());
  els.continueBtn.addEventListener('click', () => {
    if (target) navigate(target);
  });
  els.snooze.addEventListener('click', onSnoozeClick);

  const api = { refresh, render, onSnoozeClick };

  if (subscribe) subscribe(refresh);
  refresh();

  return api;
}
