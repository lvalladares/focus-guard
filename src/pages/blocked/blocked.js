import { evaluate } from '../../lib/decision.js';
import { parseHashTarget } from '../../lib/url.js';
import { isWithinSchedule, scheduleBlockingEnd } from '../../lib/schedule.js';
import { formatDuration, formatClockTime } from '../../lib/format.js';
import { randomQuoteIndex, QUOTES } from '../../lib/quotes.js';
import { defaultConfig } from '../../lib/config.js';
import { STORAGE_KEYS } from '../../lib/constants.js';

export function createBlockedController(deps) {
  const {
    document,
    location,
    storage,
    now,
    navigate,
    historyBack,
    settingsUrl,
    gateUrlOf,
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
    quote: document.getElementById('quote'),
    quoteAuthor: document.getElementById('quote-author'),
    back: document.getElementById('btn-back'),
    continueBtn: document.getElementById('btn-continue'),
    dose: document.getElementById('btn-dose'),
    settings: document.getElementById('btn-settings'),
  };

  let state = { config: defaultConfig(), runtime: { sessions: {}, cooldowns: {}, override: null } };
  let countdownTimer = null;
  let lastQuoteIndex = -1;
  let target = null;

  function stopCountdown() {
    if (countdownTimer) {
      clearInt(countdownTimer);
      countdownTimer = null;
    }
  }

  function show(el, visible) {
    el.classList.toggle('hidden', !visible);
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
    const store = await storage.get([STORAGE_KEYS.CONFIG, STORAGE_KEYS.RUNTIME]);
    const config = store[STORAGE_KEYS.CONFIG] || defaultConfig();
    const runtime = store[STORAGE_KEYS.RUNTIME] || { sessions: {}, cooldowns: {}, override: null };
    state = { config, runtime };
    render();
  }

  function render() {
    stopCountdown();
    renderQuote();
    els.wallpaper.src = wallpaperFor(state.config);
    els.settings.href = settingsUrl;
    target = parseHashTarget(location.hash);

    if (!target) {
      els.headline.textContent = 'Nothing to block here';
      els.detail.textContent = 'You opened the Focus Guard block page directly. Add distracting sites in Settings and keep your focus where it matters.';
      show(els.countdown, false);
      show(els.countdownNote, false);
      show(els.continueBtn, false);
      show(els.dose, false);
      return;
    }

    const result = evaluate({ url: target, now: now(), config: state.config, runtime: state.runtime });
    const domain = result.group ? result.group.domain : '';

    if (result.verdict === 'cooldown') {
      els.headline.textContent = 'You already had your dose';
      els.detail.innerHTML = `That is enough <strong>${domain}</strong> for now. Great sessions start when distractions end.`;
      els.countdownNote.textContent = 'You can ask again in:';
      show(els.countdown, true);
      show(els.countdownNote, true);
      show(els.continueBtn, false);
      show(els.dose, false);
      startCountdown(result.cooldownRemainingMs);
    } else if (result.verdict === 'block') {
      els.headline.textContent = 'This site is blocked';
      const end = scheduleBlockingEnd(new Date(now()), state.config.schedule);
      const endsHint = end && isWithinSchedule(new Date(now()), state.config.schedule)
        ? ` Focus hours end at <strong>${formatClockTime(end)}</strong>.`
        : '';
      els.detail.innerHTML = `<strong>${domain}</strong> is on your block list while Focus Guard is active.${endsHint}`;
      show(els.countdown, false);
      show(els.countdownNote, false);
      show(els.continueBtn, false);
      show(els.dose, false);
    } else if (result.verdict === 'gate') {
      els.headline.textContent = 'Focused work beats doomscrolling';
      els.detail.innerHTML = `Your cooldown for <strong>${domain}</strong> is over. If you truly need it, you can ask for another dose.`;
      show(els.countdown, false);
      show(els.countdownNote, false);
      show(els.continueBtn, false);
      show(els.dose, true);
    } else {
      els.headline.textContent = 'You are free to continue';
      els.detail.innerHTML = `Blocking is currently off for <strong>${domain}</strong>. Enjoy — and get back to it when the focus window returns.`;
      show(els.countdown, false);
      show(els.countdownNote, false);
      show(els.continueBtn, true);
      show(els.dose, false);
    }
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

  els.back.addEventListener('click', () => historyBack());
  els.continueBtn.addEventListener('click', () => {
    if (target) navigate(target);
  });
  els.dose.addEventListener('click', () => {
    if (target) navigate(gateUrlOf(target));
  });

  const api = { refresh, render };

  if (subscribe) subscribe(refresh);
  refresh();

  return api;
}
